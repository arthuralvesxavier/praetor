import { and, asc, count, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import type {
  CaseBriefStatus,
  EmailTemplate,
  ImportBatchStatus,
  JobStatus,
} from "@/domain/enums";
import { CASE_BRIEF_STATUSES, JOB_STATUSES } from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";
import { caseBriefWhere, emailWhere } from "@/server/auth/access";
import { assertCan } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { caseBriefs, emailMessages, importBatches, jobs, type ImportStats } from "@/server/db/schema";
import { env } from "@/server/env";
import { getEmailRuntimeInfo } from "@/server/integrations/email";
import { logger } from "@/server/lib/logger";
import { getAiRuntimeInfo } from "@/modules/analyses/service";
import { listRoutines, type RoutineItem } from "./service";

/**
 * Integrations & collection health (TE-07, RF-24). HONEST by design: every
 * integration shows what really happens in this version — tribunal
 * integrations are listed as "não integrado", the preliminary-analysis AI and
 * the e-mail are simulations, text extraction and storage run locally.
 *
 * Operational health comes from the organization's own rows (jobs, routines,
 * import batches, case briefs, simulated e-mails). Requires
 * `admin:organization`.
 */

export type IntegrationStatus = "operational" | "simulated" | "demo" | "not_integrated" | "unknown";

export const INTEGRATION_STATUS_LABELS: Record<IntegrationStatus, string> = {
  operational: "Operacional",
  simulated: "Simulado",
  demo: "Simulação demonstrativa",
  not_integrated: "Não integrado nesta versão",
  unknown: "Indisponível no momento",
};

export type IntegrationItem = {
  key: string;
  name: string;
  /** Group shown in the table ("Tribunais e publicações", "Processamento"...). */
  group: string;
  status: IntegrationStatus;
  /** Short status text (may be more specific than the generic label). */
  statusText: string;
  detail: string;
};

export type JobTypeHealth = { type: string; byStatus: Record<JobStatus, number> };

export type JobIssue = {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  /** Sanitized error (see `safeErrorMessage` in the queue). */
  lastError: string | null;
  createdAt: Date;
  /** Next attempt (queued jobs waiting for a retry). */
  runAt: Date;
  completedAt: Date | null;
};

export type ImportBatchHealth = {
  id: string;
  fileName: string;
  status: ImportBatchStatus;
  createdAt: Date;
  committedAt: Date | null;
  rolledBackAt: Date | null;
  stats: ImportStats | null;
};

export type IntegrationsOverview = {
  generatedAt: Date;
  integrations: IntegrationItem[];
  queue: {
    byStatus: Record<JobStatus, number>;
    byType: JobTypeHealth[];
    oldestQueued: { type: string; createdAt: Date; runAt: Date; ageMinutes: number } | null;
    /** Dead/failed jobs and queued jobs waiting for a retry after an error (most recent first, max 10). */
    issues: JobIssue[];
  };
  routines: RoutineItem[];
  importBatches: ImportBatchHealth[];
  briefs: { byStatus: Record<CaseBriefStatus, number>; total: number };
  emails: { last7Days: number; failedLast7Days: number; byTemplate: { template: EmailTemplate; count: number }[] };
};

const zeroJobs = (): Record<JobStatus, number> =>
  Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;

/** Static + runtime description of every integration point. */
export function describeIntegrations(): IntegrationItem[] {
  const items: IntegrationItem[] = [];
  const court = "Tribunais e publicações";
  const notIntegrated = (key: string, name: string, detail: string): IntegrationItem => ({
    key,
    name,
    group: court,
    status: "not_integrated",
    statusText: INTEGRATION_STATUS_LABELS.not_integrated,
    detail,
  });
  items.push(
    notIntegrated(
      "datajud",
      "DataJud (API pública do CNJ)",
      "Movimentações não são consultadas automaticamente. Andamentos são cadastrados manualmente ou importados de planilha.",
    ),
    notIntegrated(
      "mni",
      "MNI — Modelo Nacional de Interoperabilidade",
      "Não há envio nem recebimento eletrônico de peças ou intimações com os tribunais.",
    ),
    notIntegrated(
      "pje-acervo",
      "Painel de acervo do PJe",
      "O acervo da carteira é carregado pela importação de planilhas (Importação de planilhas).",
    ),
    notIntegrated(
      "trt-consulta",
      "Consulta pública dos TRTs",
      "Nenhuma consulta automatizada aos sites dos tribunais é feita.",
    ),
    notIntegrated(
      "diario",
      "Diário eletrônico (DJEN / DEJT)",
      "Publicações e intimações não são capturadas automaticamente; prazos são cadastrados por pessoas.",
    ),
  );

  const processing = "Processamento";
  items.push({
    key: "text-extraction",
    name: "Extração de texto (PDF e DOCX)",
    group: processing,
    status: "operational",
    statusText: "Operacional (local, sem OCR)",
    detail:
      "Executada no próprio servidor para PDF com camada de texto, DOCX e texto simples. Documentos digitalizados (somente imagem) não têm o texto extraído, pois não há OCR nesta versão.",
  });
  items.push({
    key: "spreadsheet-import",
    name: "Importação de planilhas (XLSX)",
    group: processing,
    status: "operational",
    statusText: "Operacional (local)",
    detail: "Leitura das planilhas enviadas pelo usuário, com relatório de inconsistências antes da confirmação.",
  });

  const ai = "Inteligência artificial";
  items.push({
    key: "case-brief-ai",
    name: "IA da análise preliminar de processos",
    group: ai,
    status: "demo",
    statusText: INTEGRATION_STATUS_LABELS.demo,
    detail:
      "Regras determinísticas, sem inteligência artificial real. Toda análise preliminar é rotulada como demonstrativa e precisa ser revisada e aprovada pelo advogado.",
  });
  try {
    const runtime = getAiRuntimeInfo();
    items.push(
      runtime.mode === "demo"
        ? {
            key: "analysis-ai",
            name: "IA da Central de IA (análises de documentos e registros)",
            group: ai,
            status: "demo",
            statusText: "Modo demonstrativo (sem IA real)",
            detail:
              "Nenhum provedor de IA está configurado (ou o modo demonstrativo foi forçado). As análises são geradas por um mecanismo determinístico e identificadas como demonstrativas.",
          }
        : {
            key: "analysis-ai",
            name: "IA da Central de IA (análises de documentos e registros)",
            group: ai,
            status: "operational",
            statusText: "Operacional",
            detail: `Provedor ${runtime.provider}, modelo ${runtime.model}. Toda saída exige revisão humana e respeita o limite mensal de tokens.`,
          },
    );
  } catch (error) {
    logger.error("integrations_ai_runtime_failed", { error });
    items.push({
      key: "analysis-ai",
      name: "IA da Central de IA (análises de documentos e registros)",
      group: ai,
      status: "unknown",
      statusText: INTEGRATION_STATUS_LABELS.unknown,
      detail: "Não foi possível obter a configuração do provedor de IA.",
    });
  }

  const comms = "Comunicação e armazenamento";
  const email = getEmailRuntimeInfo();
  items.push(
    email.mode === "simulated"
      ? {
          key: "email",
          name: "E-mail",
          group: comms,
          status: "simulated",
          statusText: "Simulado",
          detail:
            "As mensagens são geradas e guardadas na Central de e-mails, com o aviso “Envio simulado — nenhuma mensagem foi enviada”. Nenhum servidor de e-mail é contatado.",
        }
      : {
          key: "email",
          name: "E-mail",
          group: comms,
          status: "operational",
          statusText: "Operacional",
          detail: `Envio pelo provedor ${email.provider}.`,
        },
  );
  let maxUploadMb: number | null = null;
  try {
    maxUploadMb = env().MAX_UPLOAD_MB;
  } catch {
    maxUploadMb = null;
  }
  items.push({
    key: "storage",
    name: "Armazenamento de arquivos",
    group: comms,
    status: "operational",
    statusText: "Operacional (disco local)",
    detail: `Arquivos guardados no disco do servidor, fora do banco de dados${
      maxUploadMb ? `; limite de ${maxUploadMb.toLocaleString("pt-BR")} MB por arquivo` : ""
    }. Não há armazenamento em nuvem nesta versão.`,
  });
  return items;
}

export async function getIntegrationsOverview(ctx: AuthContext, opts: { now?: Date } = {}): Promise<IntegrationsOverview> {
  assertCan(ctx, "admin:organization");
  const now = opts.now ?? new Date();
  const db = getDb();
  const org = ctx.organizationId;
  const since7d = new Date(now.getTime() - 7 * 86_400_000);

  const [jobRows, oldest, issueRows, batchRows, briefRows, emailRows, routines] = await Promise.all([
    db
      .select({ type: jobs.type, status: jobs.status, n: count() })
      .from(jobs)
      .where(eq(jobs.organizationId, org))
      .groupBy(jobs.type, jobs.status),
    db
      .select({ type: jobs.type, createdAt: jobs.createdAt, runAt: jobs.runAt })
      .from(jobs)
      .where(and(eq(jobs.organizationId, org), eq(jobs.status, "queued")))
      .orderBy(asc(jobs.createdAt))
      .limit(1),
    db
      .select({
        id: jobs.id,
        type: jobs.type,
        status: jobs.status,
        attempts: jobs.attempts,
        maxAttempts: jobs.maxAttempts,
        lastError: jobs.lastError,
        createdAt: jobs.createdAt,
        runAt: jobs.runAt,
        completedAt: jobs.completedAt,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.organizationId, org),
          or(inArray(jobs.status, ["dead", "failed"]), and(eq(jobs.status, "queued"), isNotNull(jobs.lastError))),
        ),
      )
      .orderBy(desc(sql`coalesce(${jobs.completedAt}, ${jobs.createdAt})`))
      .limit(10),
    db
      .select({
        id: importBatches.id,
        fileName: importBatches.fileName,
        status: importBatches.status,
        createdAt: importBatches.createdAt,
        committedAt: importBatches.committedAt,
        rolledBackAt: importBatches.rolledBackAt,
        stats: importBatches.stats,
      })
      .from(importBatches)
      .where(eq(importBatches.organizationId, org))
      .orderBy(desc(importBatches.createdAt))
      .limit(5),
    db
      .select({ status: caseBriefs.status, n: count() })
      .from(caseBriefs)
      .where(caseBriefWhere(ctx))
      .groupBy(caseBriefs.status),
    db
      .select({ template: emailMessages.template, status: emailMessages.status, n: count() })
      .from(emailMessages)
      .where(and(emailWhere(ctx), gte(emailMessages.createdAt, since7d)))
      .groupBy(emailMessages.template, emailMessages.status),
    listRoutines(ctx),
  ]);

  const byStatus = zeroJobs();
  const typeMap = new Map<string, Record<JobStatus, number>>();
  for (const r of jobRows) {
    const n = Number(r.n);
    if (r.status in byStatus) byStatus[r.status] += n;
    const t = typeMap.get(r.type) ?? zeroJobs();
    if (r.status in t) t[r.status] += n;
    typeMap.set(r.type, t);
  }

  const briefsByStatus = Object.fromEntries(CASE_BRIEF_STATUSES.map((s) => [s, 0])) as Record<CaseBriefStatus, number>;
  let briefTotal = 0;
  for (const r of briefRows) {
    const n = Number(r.n);
    briefTotal += n;
    if (r.status in briefsByStatus) briefsByStatus[r.status] += n;
  }

  const templateMap = new Map<EmailTemplate, number>();
  let emailTotal = 0;
  let emailFailed = 0;
  for (const r of emailRows) {
    const n = Number(r.n);
    emailTotal += n;
    if (r.status === "failed") emailFailed += n;
    templateMap.set(r.template, (templateMap.get(r.template) ?? 0) + n);
  }

  const first = oldest[0];
  return {
    generatedAt: now,
    integrations: describeIntegrations(),
    queue: {
      byStatus,
      byType: [...typeMap.entries()].map(([type, s]) => ({ type, byStatus: s })).sort((a, b) => a.type.localeCompare(b.type)),
      oldestQueued: first
        ? {
            type: first.type,
            createdAt: first.createdAt,
            runAt: first.runAt,
            ageMinutes: Math.max(0, Math.floor((now.getTime() - first.createdAt.getTime()) / 60_000)),
          }
        : null,
      issues: issueRows,
    },
    routines,
    importBatches: batchRows,
    briefs: { byStatus: briefsByStatus, total: briefTotal },
    emails: {
      last7Days: emailTotal,
      failedLast7Days: emailFailed,
      byTemplate: [...templateMap.entries()].map(([template, c]) => ({ template, count: c })).sort((a, b) => b.count - a.count),
    },
  };
}
