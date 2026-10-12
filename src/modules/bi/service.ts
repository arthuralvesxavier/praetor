import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { BiRefreshStatus, BiRefreshTrigger } from "@/domain/enums";
import type { AuthContext } from "@/server/auth/context";
import { assertCan } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { auditLogs, biReaderRoles, biRefreshRuns, biSettings, jobs, scheduledRoutines, users } from "@/server/db/schema";
import {
  generatePowerBiEmbedToken,
  getPowerBiCredentials,
  getPowerBiReport,
  listPowerBiReports,
  missingPowerBiEnv,
} from "@/server/integrations/powerbi";
import { env } from "@/server/env";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { diffChanges, recordAudit } from "@/server/services/audit";
import { enqueueJob } from "@/server/jobs/queue";
import { biUserKey } from "./access";
import { loadBiConfig, lockBiSettingsRow, type BiConfig } from "./config";
import { refreshBlocker } from "./refresh";
import { biRefreshDedupeKey } from "./routines";
import { BI_EMBED_TOKEN_MINUTES, biSettingsSchema, embedReportParamSchema, type BiSettingsInput } from "./schemas";

/**
 * Painéis Power BI: configuração (admin:organization), token de incorporação
 * com identidade efetiva (report:read) e solicitação manual de atualização.
 * O segredo do aplicativo nunca sai do servidor; o navegador recebe apenas o
 * token de incorporação de curta duração do relatório escolhido.
 */

/** Raised when the panels cannot be shown because something is not configured yet. */
export class BiNotConfiguredError extends ConflictError {
  constructor(message: string) {
    super(message);
  }
}

function fieldErrorsOf(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join(".") : "form";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

// ---------------------------------------------------------------------------
// /paineis-bi
// ---------------------------------------------------------------------------

export type BiPageData = {
  reports: { id: string; name: string }[];
  /** Everything needed to embed is in place. */
  ready: boolean;
  /** pt-BR reason when not ready. */
  setupHint: string | null;
  credentialsConfigured: boolean;
};

export async function getBiPageData(ctx: AuthContext): Promise<BiPageData> {
  assertCan(ctx, "report:read");
  const config = await loadBiConfig(ctx.organizationId);
  const credentialsConfigured = getPowerBiCredentials() !== null;
  let setupHint: string | null = null;
  if (!credentialsConfigured) setupHint = "As credenciais do Power BI ainda não foram configuradas no servidor.";
  else if (!config.workspaceId) setupHint = "O workspace do Power BI ainda não foi cadastrado.";
  else if (config.reports.length === 0) setupHint = "Nenhum painel foi cadastrado ainda.";
  return {
    reports: config.reports.map((r) => ({ id: r.id, name: r.name })),
    ready: setupHint === null,
    setupHint,
    credentialsConfigured,
  };
}

export type BiEmbedToken = {
  reportId: string;
  reportName: string;
  embedUrl: string;
  /** Short-lived Power BI embed token (read-only, RLS identity of the current user). */
  token: string;
  expiresAt: string;
};

const EMBED_VIEW_ACTION = "bi.embed_view";
const EMBED_VIEW_WINDOW_MS = 60 * 60_000;

/**
 * Embed token for one configured report. The effective identity is the
 * current user's key (`biUserKey`), with the configured RLS role restricted
 * to the report's dataset: Power BI shows only the processes listed for that
 * key in `bi.acesso` (the same visibility as in Praetor). Audited as
 * `bi.embed_view` at most once per user and report per hour (token renewals
 * are not new views).
 */
export async function createBiEmbedToken(ctx: AuthContext, reportId: unknown): Promise<BiEmbedToken> {
  assertCan(ctx, "report:read");
  if (ctx.kind !== "user" || !ctx.userId) throw new ForbiddenError();
  const parsedId = embedReportParamSchema.safeParse(reportId);
  if (!parsedId.success) throw new ValidationError("Painel inválido.", { report: ["Painel inválido."] });

  const config = await loadBiConfig(ctx.organizationId);
  const report = config.reports.find((r) => r.id.toLowerCase() === parsedId.data.toLowerCase());
  if (!report) throw new NotFoundError("Painel não encontrado.");
  const creds = getPowerBiCredentials();
  if (!creds || !config.workspaceId) {
    throw new BiNotConfiguredError("Os painéis Power BI ainda não foram configurados. Fale com o administrador.");
  }
  if (!config.rlsRole.trim()) {
    throw new BiNotConfiguredError("O papel de segurança (RLS) dos painéis não foi configurado. Fale com o administrador.");
  }

  const info = await getPowerBiReport(creds, config.workspaceId, report.id);
  if (info.datasetId && info.datasetId.toLowerCase() !== report.datasetId.toLowerCase()) {
    throw new BiNotConfiguredError(
      "O conjunto de dados cadastrado para este painel não é o usado pelo relatório no Power BI. Fale com o administrador.",
    );
  }
  const token = await generatePowerBiEmbedToken(creds, {
    reportId: report.id,
    datasetId: report.datasetId,
    identity: { username: biUserKey(ctx.userId), roles: [config.rlsRole] },
    lifetimeMinutes: BI_EMBED_TOKEN_MINUTES,
  });

  await recordEmbedView(ctx, ctx.userId, report);
  return {
    reportId: report.id,
    reportName: report.name,
    embedUrl: info.embedUrl,
    token: token.token,
    expiresAt: token.expiration.toISOString(),
  };
}

async function recordEmbedView(ctx: AuthContext, userId: string, report: { id: string; name: string; datasetId: string }) {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bi-embed:${userId}:${report.id}`}))`);
    const [recent] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.organizationId, ctx.organizationId),
          eq(auditLogs.actorId, userId),
          eq(auditLogs.action, EMBED_VIEW_ACTION),
          sql`${auditLogs.metadata} ->> 'reportId' = ${report.id}`,
          gte(auditLogs.createdAt, new Date(Date.now() - EMBED_VIEW_WINDOW_MS)),
        ),
      )
      .limit(1);
    if (recent) return;
    await recordAudit(
      ctx,
      {
        action: EMBED_VIEW_ACTION,
        entityType: "organization",
        entityId: ctx.organizationId,
        summary: `Painel Power BI "${report.name}" exibido`,
        metadata: { reportId: report.id, datasetId: report.datasetId, role: ctx.role },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Administration (/admin/integracoes/power-bi)
// ---------------------------------------------------------------------------

export type BiRunItem = {
  id: string;
  trigger: BiRefreshTrigger;
  status: BiRefreshStatus;
  datasetId: string | null;
  datasetName: string | null;
  message: string | null;
  requestedByName: string | null;
  createdAt: Date;
  finishedAt: Date | null;
};

export type BiAdminOverview = {
  organizationId: string;
  /** Key of the current user in `bi.acesso` (to test "Exibir como função" in Power BI Desktop). */
  userKey: string | null;
  /** Read-only database users (scripts/bi-setup.ts) registered for this organization. Names only. */
  readerRoles: string[];
  config: BiConfig;
  credentials: { configured: boolean; missing: string[]; apiUrl: string; authorityUrl: string };
  refreshBlocker: string | null;
  routine: {
    enabled: boolean;
    intervalMinutes: number;
    lastRunAt: Date | null;
    lastStatus: string | null;
    lastError: string | null;
    nextRunAt: Date;
  } | null;
  pendingJob: boolean;
  runs: BiRunItem[];
};

export async function getBiAdminOverview(ctx: AuthContext): Promise<BiAdminOverview> {
  assertCan(ctx, "admin:organization");
  const db = getDb();
  const config = await loadBiConfig(ctx.organizationId);
  const missing = missingPowerBiEnv();
  const e = env();
  const [routine] = await db
    .select()
    .from(scheduledRoutines)
    .where(and(eq(scheduledRoutines.organizationId, ctx.organizationId), eq(scheduledRoutines.type, "bi_access_refresh")))
    .limit(1);
  const [pending] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, biRefreshDedupeKey(ctx.organizationId)), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  const runs = await db
    .select({
      id: biRefreshRuns.id,
      trigger: biRefreshRuns.trigger,
      status: biRefreshRuns.status,
      datasetId: biRefreshRuns.datasetId,
      message: biRefreshRuns.message,
      requestedByName: users.name,
      createdAt: biRefreshRuns.createdAt,
      finishedAt: biRefreshRuns.finishedAt,
    })
    .from(biRefreshRuns)
    .leftJoin(users, and(eq(users.id, biRefreshRuns.requestedById), eq(users.organizationId, ctx.organizationId)))
    .where(eq(biRefreshRuns.organizationId, ctx.organizationId))
    .orderBy(desc(biRefreshRuns.createdAt))
    .limit(10);
  const readers = await db
    .select({ roleName: biReaderRoles.roleName })
    .from(biReaderRoles)
    .where(eq(biReaderRoles.organizationId, ctx.organizationId))
    .orderBy(biReaderRoles.roleName);
  const datasetNames = new Map<string, string>();
  for (const r of config.reports) if (!datasetNames.has(r.datasetId.toLowerCase())) datasetNames.set(r.datasetId.toLowerCase(), r.name);

  return {
    organizationId: ctx.organizationId,
    userKey: ctx.userId ? biUserKey(ctx.userId) : null,
    readerRoles: readers.map((r) => r.roleName),
    config,
    credentials: { configured: missing.length === 0, missing, apiUrl: e.POWERBI_API_URL, authorityUrl: e.POWERBI_AUTHORITY_URL },
    refreshBlocker: refreshBlocker(config, missing.length === 0),
    routine: routine
      ? {
          enabled: routine.enabled,
          intervalMinutes: routine.intervalMinutes,
          lastRunAt: routine.lastRunAt,
          lastStatus: routine.lastStatus,
          lastError: routine.lastError,
          nextRunAt: routine.nextRunAt,
        }
      : null,
    pendingJob: Boolean(pending),
    runs: runs.map((r) => ({ ...r, datasetName: r.datasetId ? (datasetNames.get(r.datasetId.toLowerCase()) ?? null) : null })),
  };
}

function flattenConfig(c: Pick<BiConfig, "workspaceId" | "reports" | "rlsRole" | "autoRefresh">) {
  return {
    workspaceId: c.workspaceId,
    rlsRole: c.rlsRole,
    autoRefresh: c.autoRefresh,
    reports: c.reports.map((r) => `${r.name} (${r.id})`).join("; ") || null,
  };
}

/** Saves the panels configuration. Secrets are never accepted here (environment only). */
export async function updateBiSettings(ctx: AuthContext, input: BiSettingsInput): Promise<{ changed: boolean }> {
  assertCan(ctx, "admin:organization");
  const parsed = biSettingsSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(undefined, fieldErrorsOf(parsed.error));
  const data = parsed.data;
  const next = {
    workspaceId: data.workspaceId ? data.workspaceId.toLowerCase() : null,
    reports: data.reports.map((r) => ({ id: r.id.toLowerCase(), name: r.name, datasetId: r.datasetId.toLowerCase() })),
    rlsRole: data.rlsRole,
    autoRefresh: data.autoRefresh,
  };

  return getDb().transaction(async (tx) => {
    await lockBiSettingsRow(ctx.organizationId, tx);
    const before = await loadBiConfig(ctx.organizationId, tx);
    const changes = diffChanges(flattenConfig(before), flattenConfig(next));
    if (!changes) return { changed: false };
    await tx
      .update(biSettings)
      .set({ ...next, configUpdatedAt: new Date(), configUpdatedById: ctx.userId })
      .where(eq(biSettings.organizationId, ctx.organizationId));
    await recordAudit(
      ctx,
      {
        action: "organization.bi_settings_update",
        entityType: "organization",
        entityId: ctx.organizationId,
        summary: "Configuração dos painéis Power BI alterada",
        changes,
        metadata: { reports: next.reports.length },
      },
      tx,
    );
    return { changed: true };
  });
}

/** Enqueues `bi.refresh` now (access table + dataset refresh). Works without credentials (records "não executada"). */
export async function requestBiRefresh(ctx: AuthContext): Promise<{ jobId: string; deduplicated: boolean }> {
  assertCan(ctx, "admin:organization");
  return getDb().transaction(async (tx) => {
    const job = await enqueueJob(
      {
        type: "bi.refresh",
        organizationId: ctx.organizationId,
        payload: { trigger: "manual", requestedById: ctx.userId },
        dedupeKey: biRefreshDedupeKey(ctx.organizationId),
      },
      tx,
    );
    if (!job.deduplicated) {
      await recordAudit(
        ctx,
        {
          action: "bi.refresh_request",
          entityType: "organization",
          entityId: ctx.organizationId,
          summary: "Atualização dos painéis Power BI solicitada",
          metadata: { jobId: job.id },
        },
        tx,
      );
    }
    return { jobId: job.id, deduplicated: job.deduplicated };
  });
}

export type BiConnectionTest = { reports: { id: string; name: string; datasetId: string | null }[] };

/**
 * Checks the credentials and the workspace access by listing the workspace's
 * reports (names and ids only), so the administrator can copy the ids.
 */
export async function testPowerBiConnection(ctx: AuthContext): Promise<BiConnectionTest> {
  assertCan(ctx, "admin:organization");
  const creds = getPowerBiCredentials();
  if (!creds) {
    throw new BiNotConfiguredError(
      `Defina no servidor as variáveis ${missingPowerBiEnv().join(", ")} e reinicie o Praetor antes de testar a conexão.`,
    );
  }
  const config = await loadBiConfig(ctx.organizationId);
  if (!config.workspaceId) throw new ValidationError("Cadastre e salve o id do workspace antes de testar.", { workspaceId: ["Informe o workspace."] });
  const reports = await listPowerBiReports(creds, config.workspaceId);
  await recordAudit(ctx, {
    action: "bi.connection_test",
    entityType: "organization",
    entityId: ctx.organizationId,
    summary: "Teste de conexão com o Power BI",
    metadata: { reportsFound: reports.length },
  });
  return { reports: reports.map((r) => ({ id: r.id, name: r.name, datasetId: r.datasetId })) };
}
