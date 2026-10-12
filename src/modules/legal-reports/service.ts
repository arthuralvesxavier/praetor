import { createHash, randomUUID } from "node:crypto";
import packageJson from "../../../package.json";
import { and, count, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  LEGAL_REPORT_TYPE_CODES,
  LEGAL_REPORT_TYPE_LABELS,
  type LegalReportStatus,
  type LegalReportType,
  type Role,
} from "@/domain/enums";
import { normalizePage, type Paginated } from "@/domain/entities";
import {
  redactPersonalIds,
  type LegalReportDraft,
  type LegalReportScope,
  type LegalReportSequenceKey,
  type RecordSource,
  type ReportItemData,
  type ReportItemDraft,
} from "@/domain/legal-reports";
import { formatDate, todayISO } from "@/lib/format";
import { resolveAlertsByDedupeKeys, upsertAlert } from "@/modules/alerts/service";
import { loadOrganization } from "@/modules/analyses/org-settings";
import { PROCESS_SECTION_IDS, processTabUrl } from "@/modules/processes/tabs";
import { processWhere } from "@/server/auth/access";
import { systemContext, type AuthContext } from "@/server/auth/context";
import { assertCan, can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { alerts, legalProcesses, users, type OrganizationSettings } from "@/server/db/schema";
import {
  legalReportItems,
  legalReportSequences,
  legalReportSources,
  legalReports,
} from "@/server/db/schema/legal-reports";
import { buildStorageKey, getStorage, readStreamToBytes } from "@/server/integrations/storage";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { recordAudit } from "@/server/services/audit";
import { legalReportWhere } from "./access";
import { APPROVER_RULES, canApproveLegalReport, canGenerateLegalReport, canSupersedeLegalReport } from "./approvers";
import { legalReportFileName, renderLegalReportPdf } from "./pdf";
import { buildProcessReportDraft, PROCESS_REPORT_GENERATOR, processReportFingerprint } from "./process-report";
import { buildEngineSampleDraft, ENGINE_SAMPLE_GENERATOR, findVisibleProcessByNumber } from "./sample";
import {
  generateProcessReportSchema,
  generateSampleSchema,
  idSchema,
  listLegalReportsSchema,
  type GenerateProcessReportInput,
  type GenerateSampleInput,
  type ListLegalReportsInput,
} from "./schemas";
import { checkDocumentSources, type DocumentSourceResult } from "./source-checker";
import { placeItems, validateDraft, type SourceVerdict } from "./validation";
import { buildReportView, type ReportView, type StoredItem, type StoredReport, type StoredSource } from "./view";

/**
 * Relatórios jurídicos: emissão (validação, conferência de fontes, pendências,
 * referência sequencial, PDF com hash), aprovação, nova versão e download.
 *
 * Regras:
 * - item sem origem (e demais erros de `validateDraft`) BLOQUEIA a emissão;
 * - relatório aprovado é imutável: não existe atualização; gerar de novo cria
 *   a versão seguinte e a anterior passa a "substituída" (PDF e hash mantidos);
 * - aprovação só por pessoa identificada com o papel do tipo (approvers.ts);
 * - gerar e gerar nova versão exigem `report:generate` e o papel do tipo
 *   (perfis de leitura nunca geram); substituir uma versão APROVADA exige quem
 *   poderia aprová-la;
 * - documento de teste do motor usa numeração própria ("TESTE-R1-2026-0001"),
 *   sem consumir a sequência oficial do tipo;
 * - geração, aprovação e download são auditados (sem conteúdo de documentos).
 */

const PDF_MAX_BYTES = 30 * 1024 * 1024;

/** Versão do sistema gravada nos parâmetros do relatório ("Elaborado por: Praetor <versão>"). */
export const APP_VERSION: string = packageJson.version;

/**
 * Rascunho pronto para emissão. `onIssue`: gravação que o conteúdo do relatório
 * pressupõe (ex.: cenários propostos pelo sistema que a matriz apresenta), feita
 * DENTRO da transação de emissão, depois da validação: se a emissão falhar ou for
 * recusada, nada fica gravado.
 */
export type IssuableDraft = LegalReportDraft & {
  onIssue?: (tx: DbOrTx, ctx: AuthContext, issued: { reportId: string; reference: string }) => Promise<void>;
};

type Generator = (ctx: AuthContext, scope: LegalReportScope, settings: OrganizationSettings) => Promise<IssuableDraft>;

/** Geradores conhecidos (parâmetro `generator` gravado no relatório). R2 a R4 entram aqui depois. */
const GENERATORS: Record<string, Generator> = {
  [ENGINE_SAMPLE_GENERATOR]: (ctx, scope, settings) => {
    if (!scope.processId) throw new ValidationError("Escopo sem processo.");
    return buildEngineSampleDraft(ctx, { processId: scope.processId }, settings);
  },
  [PROCESS_REPORT_GENERATOR]: (ctx, scope, settings) => {
    if (!scope.processId) throw new ValidationError("Escopo sem processo.");
    return buildProcessReportDraft(ctx, { processId: scope.processId }, settings);
  },
};

/** Chave do alerta "R1 aprovado desatualizado" de um processo (um por processo). */
export function outdatedProcessReportAlertKey(processId: string): string {
  return `legal_report_outdated:${processId}`;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError("Verifique os campos informados.", z.flattenError(result.error).fieldErrors as Record<string, string[]>);
  }
  return result.data;
}

function parseId(id: string): string {
  const r = idSchema.safeParse(id);
  if (!r.success) throw new NotFoundError();
  return r.data;
}

function assertCanGenerate(ctx: AuthContext, type: LegalReportType): void {
  assertCan(ctx, "legal_report:read");
  if (!canGenerateLegalReport(ctx, type)) {
    throw new ForbiddenError(`Seu perfil não gera relatórios do tipo ${LEGAL_REPORT_TYPE_LABELS[type]}.`);
  }
}

/**
 * Texto gravado: sem travessão (regra do produto) e sem CPF ou CNPJ (minimização:
 * `redactPersonalIds`). Trechos literais de documento NÃO passam por aqui.
 */
function cleanText(value: string): string {
  return redactPersonalIds(value)
    .replace(/[ \u00a0]+[\u2012-\u2015][ \u00a0]+/g, ", ")
    .replace(/[\u2012-\u2015]/g, "-")
    .trim();
}

/** Tabela ou linha de tabela gravada: mesmas regras de texto em t\u00edtulos e c\u00e9lulas (nulo continua nulo). */
function cleanData(data: ReportItemData): ReportItemData {
  const cell = (v: string | null) => (v === null ? null : cleanText(v));
  const columns = data.columns.map((c) => ({ ...c, header: cleanText(c.header), ...(c.nullLabel ? { nullLabel: cleanText(c.nullLabel) } : {}) }));
  if (data.kind === "row") {
    return { ...data, columns, caption: data.caption ? cleanText(data.caption) : (data.caption ?? null), cells: data.cells.map(cell) };
  }
  return {
    ...data,
    columns,
    rows: data.rows.map((r) => r.map(cell)),
    totals: data.totals ? data.totals.map(cell) : null,
    note: data.note ? cleanText(data.note) : null,
  };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export type LegalReportListItem = {
  id: string;
  type: LegalReportType;
  reference: string;
  version: number;
  title: string;
  isSample: boolean;
  status: LegalReportStatus;
  scopeLabel: string;
  processId: string | null;
  baseDate: string;
  generatedAt: Date;
  generatedByName: string | null;
  approvedAt: Date | null;
};

export async function listLegalReports(ctx: AuthContext, filters: ListLegalReportsInput = {}): Promise<Paginated<LegalReportListItem>> {
  assertCan(ctx, "legal_report:read");
  const f = parse(listLegalReportsSchema, filters);
  const { page, pageSize, offset } = normalizePage(f);
  const conds: SQL[] = [legalReportWhere(ctx)];
  if (f.type) conds.push(eq(legalReports.type, f.type));
  if (f.status) conds.push(eq(legalReports.status, f.status));
  if (f.processId) conds.push(eq(legalReports.processId, f.processId));
  const where = and(...conds);
  const db = getDb();
  const [{ total }] = await db.select({ total: count() }).from(legalReports).where(where);
  const rows = await db
    .select({
      id: legalReports.id,
      type: legalReports.type,
      reference: legalReports.reference,
      version: legalReports.version,
      title: legalReports.title,
      isSample: legalReports.isSample,
      status: legalReports.status,
      parameters: legalReports.parameters,
      processId: legalReports.processId,
      baseDate: legalReports.baseDate,
      generatedAt: legalReports.generatedAt,
      generatedByName: users.name,
      approvedAt: legalReports.approvedAt,
    })
    .from(legalReports)
    .leftJoin(users, eq(users.id, legalReports.generatedById))
    .where(where)
    .orderBy(desc(legalReports.generatedAt), desc(legalReports.version))
    .limit(pageSize)
    .offset(offset);
  return {
    items: rows.map(({ parameters, ...r }) => ({ ...r, scopeLabel: parameters.scopeLabel })),
    total: Number(total),
    page,
    pageSize,
  };
}

const reportColumns = {
  id: legalReports.id,
  organizationId: legalReports.organizationId,
  type: legalReports.type,
  reference: legalReports.reference,
  referenceYear: legalReports.referenceYear,
  referenceNumber: legalReports.referenceNumber,
  version: legalReports.version,
  title: legalReports.title,
  isSample: legalReports.isSample,
  status: legalReports.status,
  scope: legalReports.scope,
  processId: legalReports.processId,
  baseDate: legalReports.baseDate,
  parameters: legalReports.parameters,
  supersedesId: legalReports.supersedesId,
  generatedAt: legalReports.generatedAt,
  generatedById: legalReports.generatedById,
  approvedById: legalReports.approvedById,
  approvedAt: legalReports.approvedAt,
  pdfStorageKey: legalReports.pdfStorageKey,
  pdfSha256: legalReports.pdfSha256,
  pdfSizeBytes: legalReports.pdfSizeBytes,
};

type ReportRow = StoredReport & {
  organizationId: string;
  referenceYear: number;
  referenceNumber: number;
  pdfStorageKey: string | null;
};

async function loadVisibleReport(ctx: AuthContext, id: string, db: DbOrTx = getDb(), lock = false): Promise<ReportRow> {
  const query = db
    .select(reportColumns)
    .from(legalReports)
    .where(and(eq(legalReports.id, parseId(id)), legalReportWhere(ctx)))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw new NotFoundError("Relatório não encontrado ou sem permissão de acesso.");
  return row;
}

async function loadItemsAndSources(db: DbOrTx, reportId: string): Promise<{ items: StoredItem[]; sources: StoredSource[] }> {
  const items = await db
    .select({
      id: legalReportItems.id,
      section: legalReportItems.section,
      position: legalReportItems.position,
      content: legalReportItems.content,
      origin: legalReportItems.origin,
      documentId: legalReportItems.documentId,
      documentVersionId: legalReportItems.documentVersionId,
      page: legalReportItems.page,
      excerpt: legalReportItems.excerpt,
      recordSource: legalReportItems.recordSource,
      derivedFrom: legalReportItems.derivedFrom,
      confidence: legalReportItems.confidence,
      simulated: legalReportItems.simulated,
      pendingReason: legalReportItems.pendingReason,
      data: legalReportItems.data,
    })
    .from(legalReportItems)
    .where(eq(legalReportItems.reportId, reportId));
  const sources = await db
    .select({
      id: legalReportSources.id,
      itemId: legalReportSources.itemId,
      reference: legalReportSources.reference,
      source: legalReportSources.source,
      url: legalReportSources.url,
      documentId: legalReportSources.documentId,
      page: legalReportSources.page,
      sensitive: legalReportSources.sensitive,
      checkedAt: legalReportSources.checkedAt,
      confirmed: legalReportSources.confirmed,
      notConfirmedReason: legalReportSources.notConfirmedReason,
    })
    .from(legalReportSources)
    .where(eq(legalReportSources.reportId, reportId));
  return { items, sources };
}

async function userNames(db: DbOrTx, ids: (string | null)[]): Promise<Map<string, { name: string; role: Role }>> {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))];
  if (!wanted.length) return new Map();
  const rows = await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(inArray(users.id, wanted));
  return new Map(rows.map((r) => [r.id, { name: r.name, role: r.role }]));
}

async function buildView(db: DbOrTx, row: ReportRow): Promise<ReportView> {
  const { items, sources } = await loadItemsAndSources(db, row.id);
  const people = await userNames(db, [row.generatedById, row.approvedById]);
  const [successor] = await db
    .select({ id: legalReports.id })
    .from(legalReports)
    .where(eq(legalReports.supersedesId, row.id))
    .limit(1);
  return buildReportView(row, items, sources, {
    generatedByName: row.generatedById ? (people.get(row.generatedById)?.name ?? null) : null,
    approvedByName: row.approvedById ? (people.get(row.approvedById)?.name ?? null) : null,
    approvedByRole: row.approvedById ? (people.get(row.approvedById)?.role ?? null) : null,
    supersededById: successor?.id ?? null,
  });
}

async function scopeResponsibleId(db: DbOrTx, row: Pick<ReportRow, "type" | "processId" | "scope" | "organizationId">): Promise<string | null> {
  if (row.type === "process_report" && row.processId) {
    const [p] = await db
      .select({ responsibleId: legalProcesses.responsibleId })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, row.processId), eq(legalProcesses.organizationId, row.organizationId)));
    return p?.responsibleId ?? null;
  }
  if (row.type === "responsibility_report") return row.scope.responsibleId ?? null;
  return null;
}

export type LegalReportDetail = {
  view: ReportView;
  versions: { id: string; version: number; status: LegalReportStatus; generatedAt: Date }[];
  processNumber: string | null;
  approverDescription: string;
  permissions: { canApprove: boolean; canRegenerate: boolean; canDownload: boolean };
};

export async function getLegalReport(ctx: AuthContext, id: string): Promise<LegalReportDetail> {
  assertCan(ctx, "legal_report:read");
  const db = getDb();
  const row = await loadVisibleReport(ctx, id, db);
  const view = await buildView(db, row);
  const versions = await db
    .select({ id: legalReports.id, version: legalReports.version, status: legalReports.status, generatedAt: legalReports.generatedAt })
    .from(legalReports)
    .where(and(eq(legalReports.reference, row.reference), legalReportWhere(ctx)))
    .orderBy(desc(legalReports.version));
  let processNumber: string | null = null;
  if (row.processId) {
    const [p] = await db
      .select({ number: legalProcesses.number })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, row.processId), processWhere(ctx)));
    processNumber = p?.number ?? null;
  }
  const responsible = await scopeResponsibleId(db, row);
  const isLatest = !view.supersededById && row.status !== "superseded";
  return {
    view,
    versions,
    processNumber,
    approverDescription: APPROVER_RULES[row.type].description,
    permissions: {
      canApprove: row.status === "pending_review" && canApproveLegalReport(ctx, { type: row.type, scopeResponsibleId: responsible }),
      canRegenerate:
        isLatest &&
        !!GENERATORS[row.parameters.generator] &&
        (!row.processId || can(ctx, "process:read")) &&
        canSupersedeLegalReport(ctx, { type: row.type, status: row.status, scopeResponsibleId: responsible }),
      canDownload: !!row.pdfStorageKey,
    },
  };
}

// ---------------------------------------------------------------------------
// Emissão
// ---------------------------------------------------------------------------

/** Referência "R1-2026-0007" (documento de teste do motor: "TESTE-R1-2026-0001"). */
export function formatLegalReportReference(code: string, year: number, number: number, opts: { sample?: boolean } = {}): string {
  return `${opts.sample ? "TESTE-" : ""}${code}-${year}-${String(number).padStart(4, "0")}`;
}

/** Chave da sequência: documentos de teste têm sequência própria e não consomem a numeração oficial. */
export function referenceSequenceKey(type: LegalReportType, isSample: boolean): LegalReportSequenceKey {
  return isSample ? `sample:${type}` : type;
}

/**
 * Próximo número da referência (organização, tipo, ano). INSERT … ON CONFLICT
 * DO UPDATE trava a linha do contador até o fim da transação: emissões
 * concorrentes esperam e nunca repetem número; uma emissão desfeita devolve o número.
 * Escolha consciente: o PDF é gerado dentro da mesma transação (a referência vai
 * no rodapé), então emissões do mesmo tipo, organização e ano ficam em fila por
 * alguns segundos; em troca, a numeração oficial nunca tem buracos.
 */
export async function allocateReferenceNumber(
  tx: DbOrTx,
  organizationId: string,
  type: LegalReportSequenceKey,
  year: number,
): Promise<number> {
  const [row] = await tx
    .insert(legalReportSequences)
    .values({ organizationId, type, year, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [legalReportSequences.organizationId, legalReportSequences.type, legalReportSequences.year],
      set: { lastNumber: sql`${legalReportSequences.lastNumber} + 1` },
    })
    .returning({ lastNumber: legalReportSequences.lastNumber });
  return row.lastNumber;
}

const TABLE_LABELS: Record<string, string> = {
  legal_processes: "Cadastro do processo",
  process_valuations: "Valorações do processo",
  process_guarantees: "Garantias do processo",
  process_risk_assessments: "Classificações de risco do processo",
  case_briefs: "Análises preliminares",
  process_scenarios: "Cenários do processo",
  organizations: "Configurações da organização",
  process_instances: "Instâncias do processo",
  process_parties: "Partes do processo",
  process_events: "Movimentações do processo",
  process_claims: "Pedidos do processo",
  deadlines: "Prazos do processo",
  hearings: "Audiências do processo",
  alerts: "Alertas do processo",
};

function recordUrl(source: RecordSource, processId: string | null): string | null {
  switch (source.table) {
    case "legal_processes":
      // Sem registro específico (ex.: lista de processos da carteira): a lista, nunca o processo do escopo.
      return source.recordId ? `/processos/${source.recordId}` : "/processos";
    case "process_valuations":
    case "process_guarantees":
      return processId ? processTabUrl(processId, "valores-e-acordos") : null;
    case "process_risk_assessments":
      return processId ? processTabUrl(processId, "valores-e-acordos", PROCESS_SECTION_IDS.risk) : null;
    case "case_briefs":
      return source.recordId ? `/analises-preliminares/${source.recordId}` : null;
    case "process_scenarios":
      return processId ? processTabUrl(processId, "valores-e-acordos", PROCESS_SECTION_IDS.scenarios) : null;
    case "process_instances":
      return processId ? processTabUrl(processId, "partes-e-andamento", PROCESS_SECTION_IDS.instances) : null;
    case "process_parties":
      return processId ? processTabUrl(processId, "partes-e-andamento", PROCESS_SECTION_IDS.parties) : null;
    case "process_events":
      return processId ? processTabUrl(processId, "partes-e-andamento", PROCESS_SECTION_IDS.timeline) : null;
    case "process_claims":
      return processId ? processTabUrl(processId, "valores-e-acordos", PROCESS_SECTION_IDS.claims) : null;
    case "deadlines":
      return processId ? processTabUrl(processId, "prazos-e-audiencias", PROCESS_SECTION_IDS.deadlines) : null;
    case "hearings":
      return processId ? processTabUrl(processId, "prazos-e-audiencias", PROCESS_SECTION_IDS.hearings) : null;
    case "alerts":
      return "/alertas";
    case "organizations":
      return "/relatorios-juridicos/parametros";
    default:
      return null;
  }
}

type PreparedReport = {
  items: (typeof legalReportItems.$inferInsert)[];
  sources: (typeof legalReportSources.$inferInsert)[];
  pendingCount: number;
  unconfirmedCount: number;
};

function prepareRows(
  ctx: AuthContext,
  reportId: string,
  draft: LegalReportDraft,
  checks: Map<string, DocumentSourceResult>,
  reasons: Map<string, string | null>,
  checkedAt: Date,
): PreparedReport {
  const ids = new Map(draft.items.map((i) => [i.key, randomUUID()]));
  const positions = new Map<string, number>();
  const processId = draft.scope.processId ?? null;
  const items: PreparedReport["items"] = [];
  const sources: PreparedReport["sources"] = [];
  let docRef = 0;
  const recordGroups = new Map<string, { source: RecordSource; labels: string[]; itemIds: string[]; at: string | null }>();

  for (const item of draft.items) {
    const id = ids.get(item.key) as string;
    const position = (positions.get(item.section) ?? 0) + 1;
    positions.set(item.section, position);
    const check = item.origin === "documented" ? checks.get(item.key) : undefined;
    const visibleDoc = check?.visible ?? false;
    items.push({
      id,
      organizationId: ctx.organizationId,
      reportId,
      section: item.section,
      position,
      content: cleanText(item.content),
      origin: item.origin as NonNullable<ReportItemDraft["origin"]>,
      documentId: item.origin === "documented" && visibleDoc ? (check?.documentId ?? null) : null,
      documentVersionId: item.origin === "documented" && visibleDoc ? (check?.documentVersionId ?? null) : null,
      page: item.origin === "documented" ? (item.page ?? null) : null,
      // PD-04: documento sensível só é referenciado (o trecho não é gravado); documento invisível não deixa rastro.
      excerpt: item.origin === "documented" && visibleDoc && !check?.sensitive ? (item.excerpt ?? null) : null,
      recordSource: item.recordSource ? { ...item.recordSource, label: cleanText(item.recordSource.label) } : null,
      derivedFrom: item.derivedFrom?.length ? item.derivedFrom.map((k) => ids.get(k) as string) : null,
      confidence: item.confidence ?? null,
      simulated: !!item.simulated,
      pendingReason: reasons.get(item.key) ?? null,
      data: item.data ? cleanData(item.data) : null,
    });

    if (item.origin === "documented") {
      docRef += 1;
      const c = check;
      sources.push({
        organizationId: ctx.organizationId,
        reportId,
        itemId: id,
        reference: `D${docRef}`,
        source:
          c?.visible && c.documentTitle
            ? cleanText(`${c.documentTitle}, versão ${c.versionNumber ?? "?"}, página ${item.page}`)
            : `Documento citado não localizado ou sem acesso, página ${item.page ?? "?"}`,
        url: c?.visible && c.documentId ? `/documentos/${c.documentId}` : null,
        documentId: c?.visible ? c.documentId : null,
        documentVersionId: c?.visible ? c.documentVersionId : null,
        page: item.page ?? null,
        documentSha256: c?.visible ? c.sha256 : null,
        sensitive: !!c?.sensitive,
        checkedAt,
        confirmed: !!c?.confirmed,
        notConfirmedReason: c?.confirmed ? null : (c?.reason ?? "Conferência não realizada."),
      });
    } else if ((item.origin === "record" || item.origin === "analysis") && item.recordSource) {
      const key = `${item.recordSource.table}:${item.recordSource.recordId ?? ""}`;
      const group = recordGroups.get(key) ?? { source: item.recordSource, labels: [], itemIds: [], at: null };
      const label = cleanText(item.recordSource.label);
      if (!group.labels.includes(label)) group.labels.push(label);
      group.itemIds.push(id);
      if (item.recordSource.recordedAt && (!group.at || item.recordSource.recordedAt > group.at)) group.at = item.recordSource.recordedAt;
      recordGroups.set(key, group);
    }
  }
  let recRef = 0;
  for (const group of recordGroups.values()) {
    recRef += 1;
    const tableLabel = TABLE_LABELS[group.source.table] ?? group.source.table;
    // "Cadastro do processo, campo X" repetido vira "Cadastro do processo: campos X, Y, Z".
    const fieldPrefix = `${tableLabel}, campo `;
    const detail =
      group.labels.length === 1
        ? group.labels[0]
        : group.labels.every((l) => l.startsWith(fieldPrefix))
          ? `${tableLabel}: campos ${group.labels.map((l) => l.slice(fieldPrefix.length)).join(", ")}`
          : `${tableLabel}: ${group.labels.join("; ")}`;
    sources.push({
      organizationId: ctx.organizationId,
      reportId,
      itemId: group.itemIds.length === 1 ? group.itemIds[0] : null,
      reference: `C${recRef}`,
      source: detail,
      url: recordUrl(group.source, processId),
      documentId: null,
      documentVersionId: null,
      page: null,
      documentSha256: null,
      sensitive: false,
      // Dado lido diretamente da base no momento da geração.
      checkedAt,
      confirmed: true,
      notConfirmedReason: null,
    });
  }
  return {
    items,
    sources,
    pendingCount: items.filter((i) => i.pendingReason).length,
    unconfirmedCount: sources.filter((s) => !s.confirmed).length,
  };
}

type SupersedeTarget = Pick<
  ReportRow,
  "id" | "reference" | "referenceYear" | "referenceNumber" | "version" | "type" | "processId" | "scope" | "isSample"
>;

/**
 * Emite um relatório a partir de um rascunho: valida (erros bloqueiam), confere
 * as fontes, decide pendências, grava com referência sequencial, gera e
 * armazena o PDF (com marca d'água) e audita. Com `supersedes`, cria a versão
 * seguinte da mesma referência e marca a anterior como substituída.
 */
export async function issueLegalReport(
  ctx: AuthContext,
  draft: IssuableDraft,
  opts: { settings: OrganizationSettings; supersedes?: SupersedeTarget },
): Promise<{ id: string; reference: string; version: number }> {
  assertCanGenerate(ctx, draft.type);
  const issues = validateDraft(draft);
  if (issues.length > 0) {
    throw new ValidationError(
      `Emissão bloqueada: ${issues.length === 1 ? "1 problema" : `${issues.length} problemas`} no conteúdo do relatório (${issues[0].message})`,
      { items: issues.map((i) => i.message) },
    );
  }
  if (draft.scope.processId) {
    const [visible] = await getDb()
      .select({ id: legalProcesses.id })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, draft.scope.processId), processWhere(ctx)));
    if (!visible) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  }

  const documented = draft.items.filter((i) => i.origin === "documented");
  const checks = await checkDocumentSources(
    ctx,
    documented.map((i) => ({
      key: i.key,
      documentId: i.documentId as string,
      documentVersionId: i.documentVersionId as string,
      page: i.page as number,
      excerpt: i.excerpt as string,
      expectedSha256: i.documentSha256 ?? null,
    })),
  );
  const verdicts = new Map<string, SourceVerdict>([...checks].map(([k, v]) => [k, { confirmed: v.confirmed, reason: v.reason }]));
  const threshold = opts.settings.legalReports.confidenceThreshold;
  const reasons = placeItems(draft.items, { threshold, sourceVerdicts: verdicts });

  const reportId = randomUUID();
  const checkedAt = new Date();
  const prepared = prepareRows(ctx, reportId, draft, checks, reasons, checkedAt);
  const storage = getStorage();
  let storedKey: string | null = null;

  try {
    return await getDb().transaction(async (tx) => {
      let reference: string;
      let referenceYear: number;
      let referenceNumber: number;
      let version = 1;
      const target = opts.supersedes;
      if (target) {
        const [current] = await tx
          .select({ status: legalReports.status })
          .from(legalReports)
          .where(and(eq(legalReports.id, target.id), eq(legalReports.organizationId, ctx.organizationId)))
          .for("update");
        const [successor] = await tx
          .select({ id: legalReports.id })
          .from(legalReports)
          .where(eq(legalReports.supersedesId, target.id))
          .limit(1);
        if (!current || current.status === "superseded" || successor) {
          throw new ConflictError("Este relatório já foi substituído por uma versão mais recente.");
        }
        if (draft.type !== target.type) throw new ValidationError("A nova versão precisa ser do mesmo tipo do relatório.");
        if (draft.isSample !== target.isSample) {
          throw new ValidationError("A nova versão precisa manter a natureza do relatório (documento de teste ou relatório).");
        }
        // Conferido sob a trava da linha: a versão pode ter sido aprovada depois da leitura.
        const responsible = await scopeResponsibleId(tx, { ...target, organizationId: ctx.organizationId });
        if (!canSupersedeLegalReport(ctx, { type: target.type, status: current.status, scopeResponsibleId: responsible })) {
          throw new ForbiddenError(
            `Uma versão aprovada só pode ser substituída por quem poderia aprová-la (${APPROVER_RULES[target.type].description}).`,
          );
        }
        reference = target.reference;
        referenceYear = target.referenceYear;
        referenceNumber = target.referenceNumber;
        version = target.version + 1;
      } else {
        referenceYear = Number(todayISO().slice(0, 4));
        referenceNumber = await allocateReferenceNumber(
          tx,
          ctx.organizationId,
          referenceSequenceKey(draft.type, draft.isSample),
          referenceYear,
        );
        reference = formatLegalReportReference(LEGAL_REPORT_TYPE_CODES[draft.type], referenceYear, referenceNumber, {
          sample: draft.isSample,
        });
      }
      // Gravações que o conteúdo pressupõe (ex.: cenários propostos): na mesma transação, depois da validação.
      if (draft.onIssue) await draft.onIssue(tx, ctx, { reportId, reference });

      const lr = opts.settings.legalReports;
      const parameters = {
        generator: draft.generator,
        generatorVersion: draft.generatorVersion,
        confidenceThreshold: lr.confidenceThreshold,
        bands: lr.bands,
        legalBasisText: lr.legalBasisText,
        subtitle: draft.subtitle ? cleanText(draft.subtitle) : null,
        sections: draft.sections.map((s) => ({
          key: s.key,
          title: cleanText(s.title),
          ...(s.note ? { note: cleanText(s.note) } : {}),
        })),
        methodology: draft.methodology.map(cleanText),
        scopeLabel: cleanText(draft.scopeLabel),
        ...(draft.layout && draft.layout !== "standard" ? { layout: draft.layout } : {}),
        ...(draft.purpose ? { purpose: cleanText(draft.purpose) } : {}),
        appVersion: APP_VERSION,
        ...(draft.dataFingerprint ? { dataFingerprint: draft.dataFingerprint } : {}),
        ...(draft.requiredPermissions?.length ? { requiredPermissions: [...new Set(draft.requiredPermissions)].sort() } : {}),
      };
      const generatedAt = new Date();
      const row = {
        id: reportId,
        organizationId: ctx.organizationId,
        type: draft.type,
        reference,
        referenceYear,
        referenceNumber,
        title: cleanText(draft.title),
        isSample: draft.isSample,
        scope: draft.scope,
        processId: draft.scope.processId ?? null,
        baseDate: draft.baseDate,
        parameters,
        status: "pending_review" as const,
        version,
        supersedesId: target?.id ?? null,
        generatedById: ctx.kind === "user" ? ctx.userId : null,
        generatedAt,
      };
      await tx.insert(legalReports).values(row);
      if (prepared.items.length) await tx.insert(legalReportItems).values(prepared.items);
      if (prepared.sources.length) await tx.insert(legalReportSources).values(prepared.sources);
      if (target) {
        await tx.update(legalReports).set({ status: "superseded" }).where(eq(legalReports.id, target.id));
      }
      // Um R1 novo (nova versão ou nova referência) atende o alerta de R1 aprovado desatualizado.
      if (draft.type === "process_report" && !draft.isSample && draft.scope.processId) {
        await resolveAlertsByDedupeKeys(ctx.organizationId, [outdatedProcessReportAlertKey(draft.scope.processId)], tx);
      }

      const { items, sources } = await loadItemsAndSources(tx, reportId);
      const view = buildReportView(
        { ...row, approvedById: null, approvedAt: null, pdfSha256: null, pdfSizeBytes: null },
        items,
        sources,
        {
          generatedByName: ctx.kind === "user" ? ctx.name : null,
          approvedByName: null,
          approvedByRole: null,
          supersededById: null,
        },
      );
      const pdf = await renderLegalReportPdf(view);
      const key = buildStorageKey(ctx.organizationId, reportId, randomUUID());
      await storage.put(key, pdf.bytes);
      storedKey = key;
      await tx
        .update(legalReports)
        .set({ pdfStorageKey: key, pdfSha256: pdf.sha256, pdfSizeBytes: pdf.bytes.byteLength })
        .where(eq(legalReports.id, reportId));

      await recordAudit(
        ctx,
        {
          action: target ? "legal_report.regenerate" : "legal_report.generate",
          entityType: "legal_report",
          entityId: reportId,
          summary: target
            ? `Nova versão (${version}) do relatório ${reference} gerada; a versão ${target.version} foi substituída.`
            : `Relatório ${reference} gerado (${LEGAL_REPORT_TYPE_LABELS[draft.type]}${draft.isSample ? ", documento de teste do motor" : ""}).`,
          metadata: {
            reference,
            version,
            type: draft.type,
            isSample: draft.isSample,
            processId: draft.scope.processId ?? null,
            items: prepared.items.length,
            pendingItems: prepared.pendingCount,
            unconfirmedSources: prepared.unconfirmedCount,
            pdfSha256: pdf.sha256,
            pdfPages: pdf.pageCount,
            supersedesId: target?.id ?? null,
          },
        },
        tx,
      );
      return { id: reportId, reference, version };
    });
  } catch (err) {
    if (storedKey) await storage.delete(storedKey).catch(() => undefined);
    throw err;
  }
}

/** "Documento de teste do motor" para um processo visível. */
export async function generateEngineSample(
  ctx: AuthContext,
  input: GenerateSampleInput,
): Promise<{ id: string; reference: string; version: number }> {
  assertCanGenerate(ctx, "process_report");
  assertCan(ctx, "process:read");
  const data = parse(generateSampleSchema, input);
  let processId = data.processId ?? null;
  if (!processId && data.processNumber) {
    const found = await findVisibleProcessByNumber(ctx, data.processNumber);
    if (!found) {
      throw new ValidationError("Processo não encontrado ou sem permissão de acesso.", {
        processNumber: ["Processo não encontrado ou sem permissão de acesso."],
      });
    }
    processId = found.id;
  }
  const org = await loadOrganization(ctx.organizationId);
  const draft = await buildEngineSampleDraft(ctx, { processId: processId as string }, org.settings);
  return issueLegalReport(ctx, draft, { settings: org.settings });
}

// ---------------------------------------------------------------------------
// R1: Relatório de Processo
// ---------------------------------------------------------------------------

export type CurrentProcessReport = {
  id: string;
  reference: string;
  version: number;
  status: LegalReportStatus;
  generatedAt: Date;
  approvedAt: Date | null;
  dataFingerprint: string | null;
};

/**
 * R1 vigente de um processo (sem filtro de perfil): a versão mais recente, não
 * substituída, gerada pelo gerador do R1 (documentos de teste e relatórios de
 * outros geradores não contam). Um processo tem uma referência de R1: gerar de
 * novo cria a versão seguinte dela.
 */
export async function currentProcessReport(organizationId: string, processId: string, db: DbOrTx = getDb()): Promise<CurrentProcessReport | null> {
  const [row] = await db
    .select({
      id: legalReports.id,
      reference: legalReports.reference,
      version: legalReports.version,
      status: legalReports.status,
      generatedAt: legalReports.generatedAt,
      approvedAt: legalReports.approvedAt,
      parameters: legalReports.parameters,
    })
    .from(legalReports)
    .where(
      and(
        eq(legalReports.organizationId, organizationId),
        eq(legalReports.processId, processId),
        eq(legalReports.type, "process_report"),
        eq(legalReports.isSample, false),
        inArray(legalReports.status, ["pending_review", "approved"]),
        sql`${legalReports.parameters}->>'generator' = ${PROCESS_REPORT_GENERATOR}`,
      ),
    )
    .orderBy(desc(legalReports.generatedAt), desc(legalReports.version))
    .limit(1);
  if (!row) return null;
  const { parameters, ...rest } = row;
  return { ...rest, dataFingerprint: parameters.dataFingerprint ?? null };
}

async function resolveProcessId(ctx: AuthContext, data: { processId?: string; processNumber?: string }): Promise<string> {
  let processId = data.processId ?? null;
  if (!processId && data.processNumber) {
    const found = await findVisibleProcessByNumber(ctx, data.processNumber);
    if (!found) {
      throw new ValidationError("Processo não encontrado ou sem permissão de acesso.", {
        processNumber: ["Processo não encontrado ou sem permissão de acesso."],
      });
    }
    processId = found.id;
  }
  const [visible] = await getDb()
    .select({ id: legalProcesses.id })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, processId as string), processWhere(ctx)));
  if (!visible) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  return visible.id;
}

/**
 * "Gerar R1" (pessoa): sem R1 vigente, emite um novo (referência R1-ano-número);
 * com R1 pendente de revisão, gera a versão seguinte (a anterior fica
 * substituída, com PDF e hash preservados); com R1 APROVADO, só quem poderia
 * aprová-lo gera a nova versão (gestor jurídico ou advogado responsável).
 */
export async function generateProcessReport(
  ctx: AuthContext,
  input: GenerateProcessReportInput,
): Promise<{ id: string; reference: string; version: number }> {
  assertCanGenerate(ctx, "process_report");
  assertCan(ctx, "process:read");
  const data = parse(generateProcessReportSchema, input);
  const processId = await resolveProcessId(ctx, data);
  const current = await currentProcessReport(ctx.organizationId, processId);
  let target: ReportRow | undefined;
  if (current) {
    try {
      target = await loadVisibleReport(ctx, current.id);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      throw new ConflictError(
        `Este processo já tem um Relatório de Processo vigente (${current.reference}) que cita documentos ou traz conteúdo fora do seu acesso. A nova versão precisa ser gerada por quem tem acesso a eles.`,
      );
    }
    if (target.status === "approved") {
      const responsible = await scopeResponsibleId(getDb(), target);
      if (!canSupersedeLegalReport(ctx, { type: target.type, status: target.status, scopeResponsibleId: responsible })) {
        throw new ForbiddenError(
          `O Relatório de Processo vigente (${target.reference}, versão ${target.version}) está aprovado: a nova versão só pode ser gerada por ${APPROVER_RULES.process_report.description}.`,
        );
      }
    }
  }
  const org = await loadOrganization(ctx.organizationId);
  const draft = await buildProcessReportDraft(ctx, { processId }, org.settings);
  return issueLegalReport(ctx, draft, { settings: org.settings, supersedes: target });
}

export type ProcessReportPanel = {
  /** R1 vigente visível a quem olha (null = sem R1, ou R1 que cita documento fora do acesso). */
  current: {
    id: string;
    reference: string;
    version: number;
    status: LegalReportStatus;
    baseDate: string;
    generatedAt: Date;
    generatedByName: string | null;
    approvedAt: Date | null;
    hasPdf: boolean;
  } | null;
  /** Há R1 vigente que quem olha não vê (cita documento fora do seu acesso). */
  hiddenCurrent: boolean;
  /** Versões anteriores (substituídas) visíveis. */
  previousVersions: number;
  /** Alerta "R1 aprovado desatualizado" aberto. */
  outdated: boolean;
  canGenerate: boolean;
  /** Motivo de não poder gerar (perfil com permissão de gerar, mas R1 aprovado de quem não pode substituí-lo). */
  blockedReason: string | null;
};

/** Painel do R1 na ficha do processo (aba "Documentos e análises"). `legal_report:read` + processo visível. */
export async function getProcessReportPanel(ctx: AuthContext, processId: string): Promise<ProcessReportPanel> {
  assertCan(ctx, "legal_report:read");
  const db = getDb();
  const [p] = await db
    .select({ id: legalProcesses.id, responsibleId: legalProcesses.responsibleId })
    .from(legalProcesses)
    .where(and(eq(legalProcesses.id, parseId(processId)), processWhere(ctx)));
  if (!p) throw new NotFoundError("Processo não encontrado ou sem permissão de acesso.");
  const cur = await currentProcessReport(ctx.organizationId, p.id, db);
  let current: ProcessReportPanel["current"] = null;
  let previousVersions = 0;
  if (cur) {
    const [row] = await db
      .select({
        id: legalReports.id,
        reference: legalReports.reference,
        version: legalReports.version,
        status: legalReports.status,
        baseDate: legalReports.baseDate,
        generatedAt: legalReports.generatedAt,
        generatedByName: users.name,
        approvedAt: legalReports.approvedAt,
        pdfStorageKey: legalReports.pdfStorageKey,
      })
      .from(legalReports)
      .leftJoin(users, eq(users.id, legalReports.generatedById))
      .where(and(eq(legalReports.id, cur.id), legalReportWhere(ctx)));
    if (row) {
      const { pdfStorageKey, ...rest } = row;
      current = { ...rest, hasPdf: !!pdfStorageKey };
      const [{ n }] = await db
        .select({ n: count() })
        .from(legalReports)
        .where(and(eq(legalReports.reference, row.reference), eq(legalReports.status, "superseded"), legalReportWhere(ctx)));
      previousVersions = Number(n);
    }
  }
  const [alert] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(
      and(
        eq(alerts.organizationId, ctx.organizationId),
        eq(alerts.dedupeKey, outdatedProcessReportAlertKey(p.id)),
        isNull(alerts.resolvedAt),
      ),
    )
    .limit(1);
  const mayGenerate = canGenerateLegalReport(ctx, "process_report") && can(ctx, "process:read");
  let blockedReason: string | null = null;
  if (mayGenerate && cur?.status === "approved") {
    if (!canSupersedeLegalReport(ctx, { type: "process_report", status: "approved", scopeResponsibleId: p.responsibleId })) {
      blockedReason = `O R1 vigente está aprovado: a nova versão só pode ser gerada por ${APPROVER_RULES.process_report.description}.`;
    }
  }
  if (mayGenerate && cur && !current) {
    blockedReason =
      "O R1 vigente cita documentos ou traz conteúdo fora do seu acesso: a nova versão precisa ser gerada por quem tem acesso a eles.";
  }
  return {
    current,
    hiddenCurrent: !!cur && !current,
    previousVersions,
    outdated: !!alert,
    canGenerate: mayGenerate && !blockedReason,
    blockedReason,
  };
}

export type ProcessReportRefreshOutcome = "created" | "new_version" | "unchanged" | "outdated_alert" | "deferred" | "process_not_found";

/**
 * Atualização automática do R1 (sistema): sem R1, cria um (só com
 * `createIfMissing`, ex.: análise preliminar aprovada); com R1 pendente de
 * revisão e dados novos (impressão digital diferente), gera a versão seguinte;
 * com R1 APROVADO e dados novos, nunca o substitui: abre o alerta
 * `legal_report_outdated` pedindo que uma pessoa gere a nova versão.
 * `allowNewVersion: false` adia a geração (limite por execução da rotina).
 */
export async function refreshProcessReportAsSystem(
  organizationId: string,
  processId: string,
  opts: { createIfMissing: boolean; allowNewVersion?: boolean; isDemo?: boolean },
): Promise<{ outcome: ProcessReportRefreshOutcome; reportId: string | null }> {
  const ctx = systemContext(organizationId, opts.isDemo ?? false);
  const fingerprint = await processReportFingerprint(organizationId, processId);
  if (fingerprint === null) return { outcome: "process_not_found", reportId: null };
  const current = await currentProcessReport(organizationId, processId);
  if (current && current.dataFingerprint === fingerprint) return { outcome: "unchanged", reportId: current.id };
  if (current?.status === "approved") {
    const [p] = await getDb()
      .select({ number: legalProcesses.number })
      .from(legalProcesses)
      .where(and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, organizationId)));
    await upsertAlert({
      organizationId,
      type: "legal_report_outdated",
      severity: "warning",
      title: `Relatório do processo ${p?.number ?? ""} aprovado e desatualizado`.replace(/\s+/g, " "),
      message:
        `O ${current.reference} (versão ${current.version}) foi aprovado${current.approvedAt ? ` em ${formatDate(current.approvedAt, "")}` : ""}, ` +
        "mas o processo tem dados novos desde a geração (fase ou instância, valores oficiais, pedidos, garantias, cenários, movimentações ou análise preliminar). " +
        `O sistema não substitui uma versão aprovada: gere a nova versão na aba "Documentos e análises" do processo (${APPROVER_RULES.process_report.description}).`,
      entityType: "legal_process",
      entityId: processId,
      dedupeKey: outdatedProcessReportAlertKey(processId),
    });
    return { outcome: "outdated_alert", reportId: current.id };
  }
  if (!current && !opts.createIfMissing) return { outcome: "unchanged", reportId: null };
  if (opts.allowNewVersion === false) return { outcome: "deferred", reportId: current?.id ?? null };
  const target = current ? await loadVisibleReport(ctx, current.id) : undefined;
  const org = await loadOrganization(organizationId);
  const draft = await buildProcessReportDraft(ctx, { processId }, org.settings);
  const issued = await issueLegalReport(ctx, draft, { settings: org.settings, supersedes: target });
  return { outcome: current ? "new_version" : "created", reportId: issued.id };
}

/** Nova versão (mesma referência) com os dados atuais; a anterior fica "substituída", com PDF e hash preservados. */
export async function regenerateLegalReport(ctx: AuthContext, id: string): Promise<{ id: string; reference: string; version: number }> {
  assertCan(ctx, "legal_report:read");
  const row = await loadVisibleReport(ctx, id);
  if (row.status === "superseded") throw new ConflictError("Este relatório já foi substituído por uma versão mais recente.");
  assertCanGenerate(ctx, row.type);
  if (row.status === "approved") {
    const responsible = await scopeResponsibleId(getDb(), row);
    if (!canSupersedeLegalReport(ctx, { type: row.type, status: row.status, scopeResponsibleId: responsible })) {
      throw new ForbiddenError(
        `Uma versão aprovada só pode ser substituída por quem poderia aprová-la (${APPROVER_RULES[row.type].description}).`,
      );
    }
  }
  const generator = GENERATORS[row.parameters.generator];
  if (!generator) throw new ValidationError("Este tipo de relatório ainda não pode ser gerado novamente.");
  if (row.processId) assertCan(ctx, "process:read");
  const org = await loadOrganization(ctx.organizationId);
  const draft = await generator(ctx, row.scope, org.settings);
  return issueLegalReport(ctx, draft, { settings: org.settings, supersedes: row });
}

// ---------------------------------------------------------------------------
// Aprovação e download
// ---------------------------------------------------------------------------

/**
 * Aprova (pessoa identificada com o papel do tipo). O PDF final é gerado com o
 * carimbo de aprovação (sem marca d'água) e o hash registrado; depois disso o
 * relatório não muda mais (só pode ser substituído por uma nova versão).
 */
export async function approveLegalReport(ctx: AuthContext, id: string): Promise<{ pdfSha256: string }> {
  assertCan(ctx, "legal_report:read");
  if (ctx.kind !== "user" || !ctx.userId) throw new ForbiddenError("A aprovação exige uma pessoa identificada.");
  const storage = getStorage();
  let storedKey: string | null = null;
  try {
    return await getDb().transaction(async (tx) => {
      const row = await loadVisibleReport(ctx, id, tx, true);
      if (row.status !== "pending_review") {
        throw new ConflictError(
          row.status === "approved"
            ? "Este relatório já foi aprovado e não pode ser alterado."
            : "Somente relatórios pendentes de revisão podem ser aprovados.",
        );
      }
      const responsible = await scopeResponsibleId(tx, row);
      if (!canApproveLegalReport(ctx, { type: row.type, scopeResponsibleId: responsible })) {
        throw new ForbiddenError(`Este relatório só pode ser aprovado por ${APPROVER_RULES[row.type].description}.`);
      }
      const approvedAt = new Date();
      const view = await buildView(tx, { ...row, status: "approved", approvedById: ctx.userId, approvedAt });
      view.approvedByName = ctx.name;
      view.approvedByRole = ctx.role;
      const pdf = await renderLegalReportPdf(view);
      const key = buildStorageKey(ctx.organizationId, row.id, randomUUID());
      await storage.put(key, pdf.bytes);
      storedKey = key;
      await tx
        .update(legalReports)
        .set({
          status: "approved",
          approvedById: ctx.userId,
          approvedAt,
          pdfStorageKey: key,
          pdfSha256: pdf.sha256,
          pdfSizeBytes: pdf.bytes.byteLength,
        })
        .where(and(eq(legalReports.id, row.id), eq(legalReports.status, "pending_review")));
      await recordAudit(
        ctx,
        {
          action: "legal_report.approve",
          entityType: "legal_report",
          entityId: row.id,
          summary: `Relatório ${row.reference} (versão ${row.version}) aprovado.`,
          metadata: {
            reference: row.reference,
            version: row.version,
            reviewPdfSha256: row.pdfSha256,
            pdfSha256: pdf.sha256,
          },
        },
        tx,
      );
      return { pdfSha256: pdf.sha256 };
    });
  } catch (err) {
    if (storedKey) await storage.delete(storedKey).catch(() => undefined);
    throw err;
  }
}

/** PDF armazenado (confere o hash registrado). Download auditado. */
export async function openLegalReportPdf(
  ctx: AuthContext,
  id: string,
): Promise<{ fileName: string; bytes: Uint8Array; sha256: string }> {
  assertCan(ctx, "legal_report:read");
  const row = await loadVisibleReport(ctx, id);
  if (!row.pdfStorageKey || !row.pdfSha256) throw new NotFoundError("O PDF deste relatório não está disponível.");
  const bytes = await readStreamToBytes(await getStorage().getStream(row.pdfStorageKey), PDF_MAX_BYTES);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== row.pdfSha256) {
    logger.error("legal_report_pdf_hash_mismatch", { reportId: row.id, userId: ctx.userId });
    throw new ConflictError("O arquivo armazenado não confere com o hash registrado do relatório. Avise o administrador.");
  }
  await recordAudit(ctx, {
    action: "legal_report.download",
    entityType: "legal_report",
    entityId: row.id,
    summary: `Download do PDF do relatório ${row.reference} (versão ${row.version}).`,
    metadata: { reference: row.reference, version: row.version, status: row.status, pdfSha256: sha256 },
  });
  return { fileName: legalReportFileName(row), bytes, sha256 };
}
