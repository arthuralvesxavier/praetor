import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AnalysisSubjectType, AnalysisType, TextExtractionStatus } from "@/domain/enums";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  LEGAL_AREA_LABELS,
  LOSS_PROBABILITY_LABELS,
  OBLIGATION_STATUS_LABELS,
  OCCURRENCE_CATEGORY_LABELS,
  OCCURRENCE_STATUS_LABELS,
  PARTY_ROLE_LABELS,
  PROCESS_EVENT_TYPE_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
  RENEWAL_TYPE_LABELS,
  RISK_LEVEL_LABELS,
  TASK_STATUS_LABELS,
} from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";
import { contractWhere, documentWhere, occurrenceWhere, processWhere } from "@/server/auth/access";
import { getDb } from "@/server/db/client";
import {
  contractObligations,
  contracts,
  documentVersions,
  documents,
  legalProcesses,
  occurrences,
  processEvents,
  processParties,
  tasks,
  units,
  users,
} from "@/server/db/schema";
import { NotFoundError } from "@/server/lib/errors";
import type { AiSource } from "@/server/integrations/ai/provider";

/**
 * Source building for AI analyses. Only records/documents visible to the
 * requesting context are included (access.ts scopes). The exact text sent to
 * the provider is never stored: we store a content hash, and the job rebuilds
 * the text deterministically from the stored source list (document versions
 * are immutable; records are re-rendered) and compares hashes.
 */

export type SourceType = "legal_process" | "occurrence" | "contract" | "document_version";

export type PreparedSource = {
  ref: string;
  sourceType: SourceType;
  entityId: string;
  versionId: string | null;
  versionNumber: number | null;
  label: string;
  text: string;
  contentHash: string;
  charCount: number;
  truncated: boolean;
};

export type SourceBundle = {
  subjectLabel: string;
  sources: PreparedSource[];
  /** Limitations about content that could not be included (pt-BR). */
  notes: string[];
  inputTruncated: boolean;
};

type Candidate = {
  sourceType: SourceType;
  entityId: string;
  versionId: string | null;
  versionNumber: number | null;
  label: string;
  rawText: string;
};

export const TRUNCATION_MARKER = "\n[… texto truncado por limite de tamanho da análise …]";
const PASSAGE_SEPARATOR = "\n[…]\n";
/** Max characters kept per source for organization-wide question/answer retrieval. */
const PASSAGE_BUDGET = 6000;
const RETRIEVAL_LIMIT = 6;
const MAX_DOCUMENTS_PER_RECORD = 25;
const MIN_TRUNCATED_CHARS = 200;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Formatting helpers (deterministic, pt-BR)
// ---------------------------------------------------------------------------

const NA = "não informado";

function dateBr(iso: string | null | undefined): string {
  if (!iso) return NA;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

const moneyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return NA;
  return moneyFormatter.format(cents / 100).replace(/ /g, " ");
}

function orNa(v: string | null | undefined): string {
  const t = v?.trim();
  return t ? t : NA;
}

function foldText(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

// ---------------------------------------------------------------------------
// Subject resolution (with visibility)
// ---------------------------------------------------------------------------

export type ResolvedSubject = {
  label: string;
  /** Parent records used to link tasks/deadlines created from suggestions. */
  processId: string | null;
  occurrenceId: string | null;
  contractId: string | null;
  documentId: string | null;
};

export function processLabel(p: { number: string; title: string }) {
  return `Processo ${p.number} — ${p.title}`;
}
export function occurrenceLabel(o: { title: string }) {
  return `Ocorrência: ${o.title}`;
}
export function contractLabel(c: { title: string; counterparty: string }) {
  return `Contrato: ${c.title} (${c.counterparty})`;
}
export function documentLabel(d: { title: string }) {
  return `Documento: ${d.title}`;
}
export const ORGANIZATION_SUBJECT_LABEL = "Base de conhecimento da organização";

/** Loads the analysis subject applying the ctx row-visibility scope. Throws NotFoundError when not visible. */
export async function resolveSubject(
  ctx: AuthContext,
  subjectType: AnalysisSubjectType,
  subjectId: string | null,
): Promise<ResolvedSubject> {
  const db = getDb();
  const empty = { processId: null, occurrenceId: null, contractId: null, documentId: null };
  if (subjectType === "organization") return { label: ORGANIZATION_SUBJECT_LABEL, ...empty };
  if (!subjectId) throw new NotFoundError();
  switch (subjectType) {
    case "legal_process": {
      const [p] = await db
        .select({ id: legalProcesses.id, number: legalProcesses.number, title: legalProcesses.title })
        .from(legalProcesses)
        .where(and(eq(legalProcesses.id, subjectId), processWhere(ctx)));
      if (!p) throw new NotFoundError();
      return { label: processLabel(p), ...empty, processId: p.id };
    }
    case "occurrence": {
      const [o] = await db
        .select({ id: occurrences.id, title: occurrences.title })
        .from(occurrences)
        .where(and(eq(occurrences.id, subjectId), occurrenceWhere(ctx)));
      if (!o) throw new NotFoundError();
      return { label: occurrenceLabel(o), ...empty, occurrenceId: o.id };
    }
    case "contract": {
      const [c] = await db
        .select({ id: contracts.id, title: contracts.title, counterparty: contracts.counterparty })
        .from(contracts)
        .where(and(eq(contracts.id, subjectId), contractWhere(ctx)));
      if (!c) throw new NotFoundError();
      return { label: contractLabel(c), ...empty, contractId: c.id };
    }
    case "document": {
      const [d] = await db
        .select({
          id: documents.id,
          title: documents.title,
          processId: documents.processId,
          occurrenceId: documents.occurrenceId,
          contractId: documents.contractId,
        })
        .from(documents)
        .where(and(eq(documents.id, subjectId), documentWhere(ctx)));
      if (!d) throw new NotFoundError();
      return {
        label: documentLabel(d),
        processId: d.processId,
        occurrenceId: d.occurrenceId,
        contractId: d.contractId,
        documentId: d.id,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Record rendering (organization-scoped; visibility is checked by the caller)
// ---------------------------------------------------------------------------

async function userName(id: string | null, organizationId: string): Promise<string> {
  if (!id) return NA;
  const [u] = await getDb()
    .select({ name: users.name })
    .from(users)
    .where(and(eq(users.id, id), eq(users.organizationId, organizationId)));
  return u?.name ?? NA;
}

async function unitName(id: string | null, organizationId: string): Promise<string> {
  if (!id) return NA;
  const [u] = await getDb()
    .select({ name: units.name })
    .from(units)
    .where(and(eq(units.id, id), eq(units.organizationId, organizationId)));
  return u?.name ?? NA;
}

export async function renderProcessRecord(
  organizationId: string,
  processId: string,
): Promise<{ label: string; text: string } | null> {
  const db = getDb();
  const [p] = await db
    .select()
    .from(legalProcesses)
    .where(
      and(eq(legalProcesses.id, processId), eq(legalProcesses.organizationId, organizationId), isNull(legalProcesses.deletedAt)),
    );
  if (!p) return null;
  const parties = await db
    .select()
    .from(processParties)
    .where(and(eq(processParties.processId, p.id), eq(processParties.organizationId, organizationId)))
    .orderBy(asc(processParties.createdAt), asc(processParties.id));
  const events = (
    await db
      .select()
      .from(processEvents)
      .where(and(eq(processEvents.processId, p.id), eq(processEvents.organizationId, organizationId)))
      .orderBy(desc(processEvents.occurredAt), desc(processEvents.createdAt), desc(processEvents.id))
      .limit(30)
  ).reverse();

  const lines = [
    "Processo judicial (dados cadastrados no sistema)",
    `Número: ${p.number}`,
    `Título: ${p.title}`,
    `Tribunal: ${orNa(p.court)}`,
    `Vara / órgão julgador: ${orNa(p.courtDivision)}`,
    `Comarca / jurisdição: ${orNa(p.jurisdiction)}`,
    `Área: ${LEGAL_AREA_LABELS[p.area] ?? p.area}`,
    `Fase: ${PROCESS_PHASE_LABELS[p.phase] ?? p.phase}`,
    `Situação: ${PROCESS_STATUS_LABELS[p.status] ?? p.status}`,
    `Unidade: ${await unitName(p.unitId, organizationId)}`,
    `Responsável: ${await userName(p.responsibleId, organizationId)}`,
    `Valor da causa: ${money(p.claimAmountCents)}`,
    `Valor provisionado: ${money(p.provisionAmountCents)}`,
    `Classificação interna de risco: ${RISK_LEVEL_LABELS[p.riskLevel] ?? p.riskLevel}`,
    `Probabilidade de perda (classificação interna): ${p.lossProbability ? LOSS_PROBABILITY_LABELS[p.lossProbability] : "não informada"}`,
    `Justificativa da classificação de risco: ${orNa(p.riskRationale)}`,
    `Data de distribuição: ${dateBr(p.filedAt)}`,
    `Data de encerramento: ${dateBr(p.closedAt)}`,
    `Origem dos dados: ${p.dataOrigin === "imported" ? `importado${p.externalSource ? ` (${p.externalSource})` : ""}` : "cadastro manual"}`,
    "",
    "Descrição:",
    orNa(p.description),
    "",
    "Partes:",
    ...(parties.length
      ? parties.map(
          (pt) =>
            `- ${pt.name} (${PARTY_ROLE_LABELS[pt.role] ?? pt.role}${pt.isClient ? "; parte representada pela empresa" : ""}${
              pt.counselName ? `; advogado(a): ${pt.counselName}` : ""
            })`,
        )
      : ["- nenhuma parte cadastrada"]),
    "",
    `Movimentações cadastradas (até as 30 mais recentes, em ordem cronológica):`,
    ...(events.length
      ? events.map(
          (e) =>
            `- ${dateBr(e.occurredAt)} — ${PROCESS_EVENT_TYPE_LABELS[e.type] ?? e.type} — ${e.title}${
              e.description ? `. ${e.description}` : ""
            }`,
        )
      : ["- nenhuma movimentação cadastrada"]),
  ];
  return { label: processLabel(p), text: lines.join("\n") };
}

export async function renderOccurrenceRecord(
  organizationId: string,
  occurrenceId: string,
): Promise<{ label: string; text: string } | null> {
  const db = getDb();
  const [o] = await db
    .select()
    .from(occurrences)
    .where(and(eq(occurrences.id, occurrenceId), eq(occurrences.organizationId, organizationId), isNull(occurrences.deletedAt)));
  if (!o) return null;
  const plan = await db
    .select({ title: tasks.title, status: tasks.status, dueDate: tasks.dueDate })
    .from(tasks)
    .where(
      and(
        eq(tasks.occurrenceId, o.id),
        eq(tasks.organizationId, organizationId),
        eq(tasks.kind, "action_plan"),
        isNull(tasks.deletedAt),
      ),
    )
    .orderBy(asc(tasks.createdAt), asc(tasks.id));

  const lines = [
    "Ocorrência do jurídico preventivo (dados cadastrados no sistema)",
    `Título: ${o.title}`,
    `Categoria: ${OCCURRENCE_CATEGORY_LABELS[o.category] ?? o.category}`,
    `Situação: ${OCCURRENCE_STATUS_LABELS[o.status] ?? o.status}`,
    `Classificação interna de risco: ${RISK_LEVEL_LABELS[o.riskLevel] ?? o.riskLevel}`,
    `Justificativa da classificação de risco: ${orNa(o.riskRationale)}`,
    `Áreas envolvidas: ${o.areasInvolved.length ? o.areasInvolved.join(", ") : NA}`,
    `Pessoas ou empresas envolvidas: ${orNa(o.involvedParties)}`,
    `Exposição estimada: ${money(o.estimatedExposureCents)}`,
    `Data do fato: ${dateBr(o.occurredOn)}`,
    `Data do relato: ${dateBr(o.reportedOn)}`,
    `Unidade: ${await unitName(o.unitId, organizationId)}`,
    `Responsável: ${await userName(o.responsibleId, organizationId)}`,
    "",
    "Relato dos fatos:",
    orNa(o.facts),
    "",
    "Informações faltantes registradas pela equipe:",
    ...(o.missingInformation.length ? o.missingInformation.map((m) => `- ${m}`) : ["- nenhuma registrada"]),
    "",
    "Plano de ação (tarefas):",
    ...(plan.length
      ? plan.map((t) => `- ${t.title} (${TASK_STATUS_LABELS[t.status] ?? t.status}${t.dueDate ? `; previsão ${dateBr(t.dueDate)}` : ""})`)
      : ["- nenhuma tarefa cadastrada"]),
  ];
  return { label: occurrenceLabel(o), text: lines.join("\n") };
}

export async function renderContractRecord(
  organizationId: string,
  contractId: string,
): Promise<{ label: string; text: string } | null> {
  const db = getDb();
  const [c] = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.id, contractId), eq(contracts.organizationId, organizationId), isNull(contracts.deletedAt)));
  if (!c) return null;
  const obligations = await db
    .select()
    .from(contractObligations)
    .where(and(eq(contractObligations.contractId, c.id), eq(contractObligations.organizationId, organizationId)))
    .orderBy(asc(contractObligations.dueDate), asc(contractObligations.createdAt), asc(contractObligations.id));

  const lines = [
    "Contrato (dados cadastrados no sistema)",
    `Título: ${c.title}`,
    `Contraparte: ${c.counterparty}`,
    `Tipo: ${CONTRACT_TYPE_LABELS[c.type] ?? c.type}`,
    `Situação: ${CONTRACT_STATUS_LABELS[c.status] ?? c.status}`,
    `Início da vigência: ${dateBr(c.startDate)}`,
    `Fim da vigência: ${dateBr(c.endDate)}`,
    `Renovação: ${RENEWAL_TYPE_LABELS[c.renewalType] ?? c.renewalType}`,
    `Antecedência para aviso de renovação/rescisão: ${c.renewalNoticeDays !== null ? `${c.renewalNoticeDays} dias` : NA}`,
    `Valor do contrato: ${money(c.valueCents)}`,
    `Classificação interna de risco: ${RISK_LEVEL_LABELS[c.riskLevel] ?? c.riskLevel}`,
    `Unidade: ${await unitName(c.unitId, organizationId)}`,
    `Responsável: ${await userName(c.responsibleId, organizationId)}`,
    "",
    "Descrição:",
    orNa(c.description),
    "",
    "Obrigações cadastradas:",
    ...(obligations.length
      ? obligations.map(
          (ob) =>
            `- ${ob.description} (vencimento ${dateBr(ob.dueDate)}; ${OBLIGATION_STATUS_LABELS[ob.status] ?? ob.status}${
              ob.recurrence ? `; recorrência: ${ob.recurrence}` : ""
            })`,
        )
      : ["- nenhuma obrigação cadastrada"]),
  ];
  return { label: contractLabel(c), text: lines.join("\n") };
}

function renderRecord(sourceType: Exclude<SourceType, "document_version">, organizationId: string, id: string) {
  switch (sourceType) {
    case "legal_process":
      return renderProcessRecord(organizationId, id);
    case "occurrence":
      return renderOccurrenceRecord(organizationId, id);
    case "contract":
      return renderContractRecord(organizationId, id);
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function documentSourceLabel(title: string, versionNumber: number) {
  return `Documento "${title}" (v${versionNumber})`;
}

function extractionNote(title: string, versionNumber: number, status: TextExtractionStatus, empty: boolean): string {
  const reason =
    status === "pending"
      ? "o texto ainda está sendo extraído"
      : status === "failed"
        ? "a extração de texto falhou"
        : status === "unsupported"
          ? "o formato do arquivo não permite extração de texto"
          : empty
            ? "o arquivo não contém texto extraível"
            : "texto indisponível";
  return `O documento "${title}" (v${versionNumber}) não foi considerado: ${reason}.`;
}

type DocRow = {
  id: string;
  title: string;
  category: string;
  versionId: string;
  versionNumber: number;
  extractionStatus: TextExtractionStatus;
  extractedText: string | null;
};

const docColumns = {
  id: documents.id,
  title: documents.title,
  category: documents.category,
  versionId: documentVersions.id,
  versionNumber: documentVersions.versionNumber,
  extractionStatus: documentVersions.extractionStatus,
  extractedText: documentVersions.extractedText,
};

async function visibleDocumentsWhere(ctx: AuthContext, link: SQL): Promise<DocRow[]> {
  return getDb()
    .select(docColumns)
    .from(documents)
    .innerJoin(
      documentVersions,
      and(eq(documentVersions.id, documents.currentVersionId), eq(documentVersions.organizationId, ctx.organizationId)),
    )
    .where(and(link, documentWhere(ctx)))
    .orderBy(asc(documents.createdAt), asc(documents.id));
}

function docCandidates(rows: DocRow[], notes: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const d of rows) {
    const text = d.extractedText?.trim() ?? "";
    if (d.extractionStatus !== "succeeded" || !text) {
      notes.push(extractionNote(d.title, d.versionNumber, d.extractionStatus, !text));
      continue;
    }
    if (out.length >= MAX_DOCUMENTS_PER_RECORD) {
      notes.push(`O documento "${d.title}" não foi considerado: limite de ${MAX_DOCUMENTS_PER_RECORD} documentos por análise.`);
      continue;
    }
    out.push({
      sourceType: "document_version",
      entityId: d.id,
      versionId: d.versionId,
      versionNumber: d.versionNumber,
      label: `${documentSourceLabel(d.title, d.versionNumber)} — ${DOCUMENT_CATEGORY_LABELS[d.category as keyof typeof DOCUMENT_CATEGORY_LABELS] ?? d.category}`,
      rawText: text,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Organization-wide retrieval (question/answer)
// ---------------------------------------------------------------------------

const QUERY_STOPWORDS = new Set(
  "a o as os de da do das dos e em no na nos nas um uma uns umas para por com sem que qual quais quando onde como sobre entre ao aos pelo pela pelos pelas se ha foi sao ser esta este essa esse isso isto existe existem algum alguma alguns algumas tem possui quem mais menos ja nao sim ou temos ter qualquer".split(
    " ",
  ),
);

/** Normalized search terms of a question (letters/digits only, so they are safe for websearch_to_tsquery). */
export function questionTerms(question: string): string[] {
  const terms = foldText(question)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t));
  return Array.from(new Set(terms)).slice(0, 16);
}

function stem(term: string): string {
  return term.length > 5 ? term.slice(0, term.length - 2) : term;
}

/** Keeps the passages of `text` that best match the terms, in original order, within the budget. */
export function selectPassages(text: string, terms: string[], budget = PASSAGE_BUDGET): string {
  if (text.length <= budget) return text;
  let chunks = text.split(/\n\s*\n/).filter((c) => c.trim());
  if (chunks.length < 3) chunks = text.split(/\n/).filter((c) => c.trim());
  // Split oversized chunks by sentences into ~800-char pieces.
  const pieces: string[] = [];
  for (const c of chunks) {
    if (c.length <= 1200) {
      pieces.push(c.trim());
      continue;
    }
    let cur = "";
    for (const s of c.split(/(?<=[.!?;])\s+/)) {
      if (cur && cur.length + s.length > 800) {
        pieces.push(cur.trim());
        cur = "";
      }
      cur += (cur ? " " : "") + s;
    }
    if (cur.trim()) pieces.push(cur.trim());
  }
  const stems = terms.map(stem);
  const scored = pieces.map((p, i) => {
    const f = foldText(p);
    let score = 0;
    for (const s of stems) if (f.includes(s)) score++;
    return { i, p, score };
  });
  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  if (!ranked.length) return text.slice(0, budget);
  const chosen: typeof ranked = [];
  let used = 0;
  for (const r of ranked) {
    const cost = Math.min(r.p.length, budget) + PASSAGE_SEPARATOR.length;
    if (used + cost > budget && chosen.length) continue;
    chosen.push({ ...r, p: r.p.slice(0, budget) });
    used += cost;
  }
  chosen.sort((a, b) => a.i - b.i);
  return chosen.map((c) => c.p).join(PASSAGE_SEPARATOR);
}

type RankedHit = { rank: number; order: string; candidate: () => Promise<Candidate | null> };

async function retrieveForQuestion(ctx: AuthContext, question: string, notes: string[]): Promise<Candidate[]> {
  const db = getDb();
  const terms = questionTerms(question);
  if (!terms.length) {
    notes.push("A pergunta não contém termos suficientes para a busca nas fontes.");
    return [];
  }
  const q = terms.join(" or ");
  const tsq = sql`websearch_to_tsquery('portuguese', ${q})`;
  const hits: RankedHit[] = [];

  const docVector = sql`to_tsvector('portuguese', coalesce(${documentVersions.extractedText}, ''))`;
  const docRows = await db
    .select({ ...docColumns, rank: sql<number>`ts_rank(${docVector}, ${tsq})` })
    .from(documents)
    .innerJoin(
      documentVersions,
      and(eq(documentVersions.id, documents.currentVersionId), eq(documentVersions.organizationId, ctx.organizationId)),
    )
    .where(and(documentWhere(ctx), eq(documentVersions.extractionStatus, "succeeded"), sql`${docVector} @@ ${tsq}`))
    .orderBy(desc(sql`ts_rank(${docVector}, ${tsq})`), asc(documents.id))
    .limit(RETRIEVAL_LIMIT);
  for (const d of docRows) {
    hits.push({
      rank: Number(d.rank),
      order: `d:${d.id}`,
      candidate: async () => docCandidates([d], [])[0] ?? null,
    });
  }

  const pVector = sql`to_tsvector('portuguese', concat_ws(' ', ${legalProcesses.number}, ${legalProcesses.title}, ${legalProcesses.court}, ${legalProcesses.description}, ${legalProcesses.riskRationale}))`;
  const pRows = await db
    .select({ id: legalProcesses.id, rank: sql<number>`ts_rank(${pVector}, ${tsq})` })
    .from(legalProcesses)
    .where(and(processWhere(ctx), sql`${pVector} @@ ${tsq}`))
    .orderBy(desc(sql`ts_rank(${pVector}, ${tsq})`), asc(legalProcesses.id))
    .limit(RETRIEVAL_LIMIT);
  for (const r of pRows) hits.push({ rank: Number(r.rank), order: `p:${r.id}`, candidate: () => recordCandidate(ctx, "legal_process", r.id) });

  const oVector = sql`to_tsvector('portuguese', concat_ws(' ', ${occurrences.title}, ${occurrences.facts}, ${occurrences.involvedParties}, ${occurrences.riskRationale}))`;
  const oRows = await db
    .select({ id: occurrences.id, rank: sql<number>`ts_rank(${oVector}, ${tsq})` })
    .from(occurrences)
    .where(and(occurrenceWhere(ctx), sql`${oVector} @@ ${tsq}`))
    .orderBy(desc(sql`ts_rank(${oVector}, ${tsq})`), asc(occurrences.id))
    .limit(RETRIEVAL_LIMIT);
  for (const r of oRows) hits.push({ rank: Number(r.rank), order: `o:${r.id}`, candidate: () => recordCandidate(ctx, "occurrence", r.id) });

  const cVector = sql`to_tsvector('portuguese', concat_ws(' ', ${contracts.title}, ${contracts.counterparty}, ${contracts.description}))`;
  const cRows = await db
    .select({ id: contracts.id, rank: sql<number>`ts_rank(${cVector}, ${tsq})` })
    .from(contracts)
    .where(and(contractWhere(ctx), sql`${cVector} @@ ${tsq}`))
    .orderBy(desc(sql`ts_rank(${cVector}, ${tsq})`), asc(contracts.id))
    .limit(RETRIEVAL_LIMIT);
  for (const r of cRows) hits.push({ rank: Number(r.rank), order: `c:${r.id}`, candidate: () => recordCandidate(ctx, "contract", r.id) });

  hits.sort((a, b) => b.rank - a.rank || a.order.localeCompare(b.order));
  const out: Candidate[] = [];
  for (const h of hits.slice(0, RETRIEVAL_LIMIT)) {
    const c = await h.candidate();
    if (c) out.push(c);
  }
  if (!out.length) notes.push("Nenhum documento ou registro acessível contém termos relacionados à pergunta.");
  return out;
}

async function recordCandidate(
  ctx: AuthContext,
  sourceType: Exclude<SourceType, "document_version">,
  id: string,
): Promise<Candidate | null> {
  const r = await renderRecord(sourceType, ctx.organizationId, id);
  if (!r) return null;
  return { sourceType, entityId: id, versionId: null, versionNumber: null, label: r.label, rawText: r.text };
}

// ---------------------------------------------------------------------------
// Pipeline: candidates -> (passages) -> proportional truncation -> refs + hashes
// ---------------------------------------------------------------------------

function preprocess(rawText: string, mode: { passages: boolean; terms: string[] }): string {
  return mode.passages ? selectPassages(rawText, mode.terms) : rawText;
}

function applyBudget(texts: string[], maxInputChars: number): { text: string; truncated: boolean }[] {
  const total = texts.reduce((n, t) => n + t.length, 0);
  if (maxInputChars <= 0 || total <= maxInputChars) return texts.map((text) => ({ text, truncated: false }));
  return texts.map((t) => {
    const allowed = Math.max(MIN_TRUNCATED_CHARS, Math.floor((t.length * maxInputChars) / total));
    if (t.length <= allowed) return { text: t, truncated: false };
    return { text: t.slice(0, allowed) + TRUNCATION_MARKER, truncated: true };
  });
}

function finalize(candidates: Candidate[], mode: { passages: boolean; terms: string[] }, maxInputChars: number): PreparedSource[] {
  const pre = candidates.map((c) => preprocess(c.rawText, mode));
  const budgeted = applyBudget(pre, maxInputChars);
  return candidates.map((c, i) => {
    const { text, truncated } = budgeted[i];
    return {
      ref: `S${i + 1}`,
      sourceType: c.sourceType,
      entityId: c.entityId,
      versionId: c.versionId,
      versionNumber: c.versionNumber,
      label: c.label,
      text,
      contentHash: sha256(text),
      charCount: text.length,
      truncated,
    };
  });
}

/** Builds the source list for a request, using only what `ctx` can see. */
export async function buildAnalysisSources(
  ctx: AuthContext,
  params: { type: AnalysisType; subjectType: AnalysisSubjectType; subjectId: string | null; question: string | null },
  subject: ResolvedSubject,
  maxInputChars: number,
): Promise<SourceBundle> {
  const notes: string[] = [];
  let candidates: Candidate[] = [];
  const id = params.subjectId;

  switch (params.subjectType) {
    case "legal_process":
    case "occurrence":
    case "contract": {
      if (!id) throw new NotFoundError();
      const record = await recordCandidate(ctx, params.subjectType, id);
      if (!record) throw new NotFoundError();
      const link =
        params.subjectType === "legal_process"
          ? eq(documents.processId, id)
          : params.subjectType === "occurrence"
            ? eq(documents.occurrenceId, id)
            : eq(documents.contractId, id);
      candidates = [record, ...docCandidates(await visibleDocumentsWhere(ctx, link), notes)];
      break;
    }
    case "document": {
      if (!id) throw new NotFoundError();
      candidates = docCandidates(await visibleDocumentsWhere(ctx, eq(documents.id, id)), notes);
      break;
    }
    case "organization": {
      candidates = await retrieveForQuestion(ctx, params.question ?? "", notes);
      break;
    }
  }

  const mode = { passages: params.subjectType === "organization", terms: questionTerms(params.question ?? "") };
  const sources = finalize(candidates, mode, maxInputChars);
  return { subjectLabel: subject.label, sources, notes, inputTruncated: sources.some((s) => s.truncated) };
}

// ---------------------------------------------------------------------------
// Rebuild at run time (staleness check)
// ---------------------------------------------------------------------------

export type StoredSource = {
  ref: string;
  sourceType: string;
  entityId: string;
  versionId: string | null;
  versionNumber: number | null;
  label: string;
  contentHash: string;
  charCount: number;
  truncated: boolean;
};

/**
 * Re-creates the exact texts that were hashed at request time. Returns null
 * when any source no longer exists or its content hash differs.
 */
export async function rebuildSourceTexts(
  organizationId: string,
  analysis: { subjectType: AnalysisSubjectType; question: string | null },
  stored: StoredSource[],
): Promise<AiSource[] | null> {
  const db = getDb();
  const mode = { passages: analysis.subjectType === "organization", terms: questionTerms(analysis.question ?? "") };
  const ordered = [...stored].sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)));

  const versionIds = ordered.filter((s) => s.sourceType === "document_version" && s.versionId).map((s) => s.versionId!);
  const versions = versionIds.length
    ? await db
        .select({
          id: documentVersions.id,
          documentId: documentVersions.documentId,
          extractedText: documentVersions.extractedText,
        })
        .from(documentVersions)
        .innerJoin(documents, eq(documents.id, documentVersions.documentId))
        .where(
          and(
            inArray(documentVersions.id, versionIds),
            eq(documentVersions.organizationId, organizationId),
            isNull(documents.deletedAt),
          ),
        )
    : [];
  const byVersion = new Map(versions.map((v) => [v.id, v]));

  const out: AiSource[] = [];
  for (const s of ordered) {
    let raw: string | null = null;
    if (s.sourceType === "document_version") {
      const v = s.versionId ? byVersion.get(s.versionId) : undefined;
      if (!v || v.documentId !== s.entityId) return null;
      raw = v.extractedText?.trim() ?? null;
    } else if (s.sourceType === "legal_process" || s.sourceType === "occurrence" || s.sourceType === "contract") {
      raw = (await renderRecord(s.sourceType, organizationId, s.entityId))?.text ?? null;
    }
    if (raw === null) return null;
    let text = preprocess(raw, mode);
    if (s.truncated) {
      const limit = s.charCount - TRUNCATION_MARKER.length;
      if (limit < 0 || text.length <= limit) return null;
      text = text.slice(0, limit) + TRUNCATION_MARKER;
    }
    if (sha256(text) !== s.contentHash) return null;
    out.push({ ref: s.ref, kind: s.sourceType, label: s.label, text });
  }
  return out;
}
