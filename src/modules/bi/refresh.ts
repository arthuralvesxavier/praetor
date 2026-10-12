import { and, desc, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { BI_REFRESH_TRIGGER_LABELS, type BiRefreshTrigger } from "@/domain/enums";
import { getDb } from "@/server/db/client";
import { biRefreshRuns, biSettings, importBatches, portfolioSnapshots } from "@/server/db/schema";
import { getLatestPowerBiRefresh, getPowerBiCredentials, PowerBiError, requestPowerBiDatasetRefresh } from "@/server/integrations/powerbi";
import { logger } from "@/server/lib/logger";
import { errorSummary } from "@/modules/documents/log";
import { refreshBiAccess } from "./access";
import { configuredDatasets, loadBiConfig, type BiConfig } from "./config";

/**
 * Atualização automática dos painéis: o job `bi.refresh` recalcula a tabela de
 * acessos e pede ao Power BI a atualização de cada conjunto de dados
 * configurado. Sem credenciais ou sem configuração, registra "não executada"
 * e termina sem erro (nada quebra). Falhas do Power BI ficam no histórico
 * (`bi_refresh_runs`), exibido em Administração > Integrações > Power BI.
 */

export type BiRefreshJobPayload = {
  trigger: BiRefreshTrigger;
  /** Latest source event (import, closing, court sync, access change) seen when the job was enqueued. */
  watermark?: string | null;
  requestedById?: string | null;
};

export type BiRefreshJobResult = { requested: number; failed: number; skipped: boolean };

/** Why a refresh cannot be requested now (null = ready). */
export function refreshBlocker(config: Pick<BiConfig, "workspaceId" | "reports">, hasCredentials: boolean): string | null {
  if (!hasCredentials) {
    return "Credenciais do Power BI não configuradas no servidor (POWERBI_TENANT_ID, POWERBI_CLIENT_ID e POWERBI_CLIENT_SECRET).";
  }
  if (!config.workspaceId) return "Workspace do Power BI não cadastrado.";
  if (configuredDatasets(config).length === 0) return "Nenhum painel com conjunto de dados cadastrado.";
  return null;
}

export async function runBiRefreshJob(organizationId: string, payload: BiRefreshJobPayload): Promise<BiRefreshJobResult> {
  const db = getDb();
  await refreshBiAccess(organizationId);
  // Everything that happened up to now (including the access rows just
  // rebuilt) is read by the refresh requested below, whatever triggered it
  // (routine or "Atualizar agora"): that is the watermark to record.
  const coveredUntil = await latestSourceChange(organizationId);
  const config = await loadBiConfig(organizationId);
  const creds = getPowerBiCredentials();
  const blocker = refreshBlocker(config, creds !== null);
  if (blocker || !creds || !config.workspaceId) {
    await db.insert(biRefreshRuns).values({
      organizationId,
      trigger: payload.trigger,
      status: "skipped",
      message: `Acessos recalculados; atualização do Power BI não executada: ${blocker ?? "configuração incompleta."}`,
      requestedById: payload.requestedById ?? null,
      finishedAt: new Date(),
    });
    return { requested: 0, failed: 0, skipped: true };
  }

  let requested = 0;
  let failed = 0;
  for (const datasetId of configuredDatasets(config)) {
    try {
      const { requestId } = await requestPowerBiDatasetRefresh(creds, config.workspaceId, datasetId);
      requested++;
      await db.insert(biRefreshRuns).values({
        organizationId,
        trigger: payload.trigger,
        status: "requested",
        datasetId,
        requestId,
        message: "Atualização aceita pelo Power BI; a conclusão é conferida na próxima execução da rotina.",
        requestedById: payload.requestedById ?? null,
      });
    } catch (err) {
      failed++;
      const message =
        err instanceof PowerBiError ? err.userMessage : "Erro interno ao solicitar a atualização. Tente novamente mais tarde.";
      if (!(err instanceof PowerBiError)) logger.error("bi_refresh_failed", { organizationId, ...errorSummary(err) });
      else logger.warn("bi_refresh_rejected", { organizationId, code: err.code, status: err.status, serviceCode: err.serviceCode });
      await db.insert(biRefreshRuns).values({
        organizationId,
        trigger: payload.trigger,
        status: "failed",
        datasetId,
        message,
        requestedById: payload.requestedById ?? null,
        finishedAt: new Date(),
      });
    }
  }

  // The source watermark only advances when Power BI accepted the request, so
  // a failed attempt is retried by the next routine run. A manual refresh
  // advances it too, so the routine does not spend another refresh on the
  // same news.
  const fromPayload = payload.watermark ? new Date(payload.watermark) : null;
  const candidates = [fromPayload, coveredUntil?.at ?? null].filter((d): d is Date => d !== null && !Number.isNaN(d.getTime()));
  const watermark = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
  if (requested > 0 && watermark) {
    const iso = watermark.toISOString();
    await db
      .update(biSettings)
      .set({ sourceWatermarkAt: sql`greatest(coalesce(${biSettings.sourceWatermarkAt}, ${iso}::timestamptz), ${iso}::timestamptz)` })
      .where(eq(biSettings.organizationId, organizationId));
  }
  return { requested, failed, skipped: false };
}

// ---------------------------------------------------------------------------
// Completion check of requested refreshes
// ---------------------------------------------------------------------------

const COMPLETED = new Set(["Completed"]);
const FAILED = new Set(["Failed", "Cancelled", "Disabled"]);

/**
 * Asks Power BI how the requested refreshes ended (Completed / Failed) and
 * records the outcome. Returns how many runs were concluded.
 */
export async function checkRequestedRefreshes(organizationId: string, config: BiConfig): Promise<number> {
  const creds = getPowerBiCredentials();
  if (!creds || !config.workspaceId) return 0;
  const db = getDb();
  const since = new Date(Date.now() - 2 * 86_400_000);
  const pending = await db
    .select()
    .from(biRefreshRuns)
    .where(
      and(
        eq(biRefreshRuns.organizationId, organizationId),
        eq(biRefreshRuns.status, "requested"),
        isNotNull(biRefreshRuns.datasetId),
        gte(biRefreshRuns.createdAt, since),
      ),
    )
    .orderBy(desc(biRefreshRuns.createdAt))
    .limit(20);
  let concluded = 0;
  const seen = new Set<string>();
  for (const run of pending) {
    const datasetId = run.datasetId!;
    // Only the most recent request of each dataset can be matched with "latest refresh".
    if (seen.has(datasetId)) continue;
    seen.add(datasetId);
    try {
      const latest = await getLatestPowerBiRefresh(creds, config.workspaceId, datasetId);
      if (!latest) continue;
      const sameRequest = run.requestId ? latest.requestId === run.requestId : latest.endTime !== null && latest.endTime >= run.createdAt;
      if (!sameRequest) continue;
      if (COMPLETED.has(latest.status)) {
        await db
          .update(biRefreshRuns)
          .set({ status: "succeeded", finishedAt: latest.endTime ?? new Date(), message: "Atualização concluída no Power BI." })
          .where(and(eq(biRefreshRuns.id, run.id), eq(biRefreshRuns.status, "requested")));
        concluded++;
      } else if (FAILED.has(latest.status)) {
        const code = latest.serviceExceptionCode ? ` (código ${latest.serviceExceptionCode})` : "";
        await db
          .update(biRefreshRuns)
          .set({
            status: "failed",
            finishedAt: latest.endTime ?? new Date(),
            message: `O Power BI informou que a atualização não foi concluída${code}. Confira o gateway e as credenciais da fonte de dados no Power BI.`,
          })
          .where(and(eq(biRefreshRuns.id, run.id), eq(biRefreshRuns.status, "requested")));
        concluded++;
      }
    } catch (err) {
      // Status check is best effort: the next routine run asks again.
      if (err instanceof PowerBiError) logger.warn("bi_refresh_status_unavailable", { organizationId, code: err.code });
      else logger.error("bi_refresh_status_failed", { organizationId, ...errorSummary(err) });
    }
  }
  return concluded;
}

// ---------------------------------------------------------------------------
// Change detection (read-only on the source tables)
// ---------------------------------------------------------------------------

export type SourceChange = { at: Date; trigger: Exclude<BiRefreshTrigger, "schedule" | "manual"> };

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

async function latestImportChange(organizationId: string): Promise<Date | null> {
  const [row] = await getDb()
    .select({
      at: sql<unknown>`max(greatest(coalesce(${importBatches.committedAt}, 'epoch'::timestamptz), coalesce(${importBatches.rolledBackAt}, 'epoch'::timestamptz)))`,
    })
    .from(importBatches)
    .where(and(eq(importBatches.organizationId, organizationId), inArray(importBatches.status, ["committed", "rolled_back"])));
  const at = toDate(row?.at);
  return at && at.getTime() > 0 ? at : null;
}

async function latestSnapshotClose(organizationId: string): Promise<Date | null> {
  const [row] = await getDb()
    .select({ at: sql<unknown>`max(${portfolioSnapshots.closedAt})` })
    .from(portfolioSnapshots)
    .where(and(eq(portfolioSnapshots.organizationId, organizationId), eq(portfolioSnapshots.status, "closed")));
  return toDate(row?.at);
}

/**
 * Court data collection (`court_sync_runs`, DataJud) is read only when the
 * table exists in this installation; runs that brought news (new movements or
 * phase changes) count when those columns exist, otherwise any finished run.
 */
async function latestCourtSync(organizationId: string): Promise<Date | null> {
  const db = getDb();
  const res = (await db.execute(sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'court_sync_runs'
  `)) as unknown as { rows: { column_name: string }[] };
  const cols = new Set(res.rows.map((r) => r.column_name));
  if (!cols.has("organization_id") || !cols.has("finished_at")) return null;
  const news = cols.has("new_movements") && cols.has("phase_changes") ? sql` and (new_movements > 0 or phase_changes > 0)` : sql``;
  const out = (await db.execute(sql`
    select max(finished_at) as at from court_sync_runs
    where organization_id = ${organizationId} and finished_at is not null${news}
  `)) as unknown as { rows: { at: unknown }[] };
  return toDate(out.rows[0]?.at);
}

/**
 * Last change of the access rows (`refreshBiAccess`): a process marked
 * confidential, reassigned or moved, a user moved to another unit, a role
 * changed or a user deactivated. In Import mode the dataset keeps the old
 * `bi.acesso` until it is refreshed, so this is a refresh reason like any
 * other (still subject to the minimum interval and the daily limit).
 */
async function latestAccessChange(organizationId: string): Promise<Date | null> {
  const [row] = await getDb()
    .select({ at: biSettings.accessChangedAt })
    .from(biSettings)
    .where(eq(biSettings.organizationId, organizationId))
    .limit(1);
  return row?.at ?? null;
}

/** Newest source event (import commit/rollback, closed month, court sync with news, access change). */
export async function latestSourceChange(organizationId: string): Promise<SourceChange | null> {
  const candidates: { at: Date | null; trigger: SourceChange["trigger"] }[] = [
    { at: await latestImportChange(organizationId), trigger: "import_batch" },
    { at: await latestSnapshotClose(organizationId), trigger: "snapshot_closed" },
    { at: await latestCourtSync(organizationId), trigger: "court_sync" },
    { at: await latestAccessChange(organizationId), trigger: "access_change" },
  ];
  let best: SourceChange | null = null;
  for (const c of candidates) if (c.at && (!best || c.at > best.at)) best = { at: c.at, trigger: c.trigger };
  return best;
}

// ---------------------------------------------------------------------------
// Automatic refresh decision (used by the routine)
// ---------------------------------------------------------------------------

export type BiRefreshPolicy = {
  /** Periodic refresh even without news (hours); 0 = only on news. */
  scheduledRefreshHours: number;
  /** Minimum minutes between two automatic requests. */
  minIntervalMinutes: number;
  /** Max accepted refreshes per dataset in 24 h (Power BI Pro allows 8). */
  maxRefreshesPerDay: number;
};

export const DEFAULT_BI_REFRESH_POLICY: BiRefreshPolicy = { scheduledRefreshHours: 24, minIntervalMinutes: 60, maxRefreshesPerDay: 8 };

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export function refreshPolicyFrom(config: Record<string, unknown>): BiRefreshPolicy {
  const d = DEFAULT_BI_REFRESH_POLICY;
  return {
    scheduledRefreshHours: bounded(config.scheduledRefreshHours, 0, 24 * 30, d.scheduledRefreshHours),
    minIntervalMinutes: bounded(config.minIntervalMinutes, 15, 24 * 60, d.minIntervalMinutes),
    maxRefreshesPerDay: bounded(config.maxRefreshesPerDay, 1, 48, d.maxRefreshesPerDay),
  };
}

export type RefreshDecision =
  | { kind: "enqueue"; trigger: BiRefreshTrigger; watermark: Date | null }
  | { kind: "throttled"; trigger: BiRefreshTrigger }
  | { kind: "none" };

export async function decideAutomaticRefresh(
  organizationId: string,
  config: BiConfig,
  policy: BiRefreshPolicy,
  now: Date = new Date(),
): Promise<RefreshDecision> {
  const change = await latestSourceChange(organizationId);
  const hasNews = change !== null && (!config.sourceWatermarkAt || change.at > config.sourceWatermarkAt);

  const db = getDb();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const recent = await db
    .select({ status: biRefreshRuns.status, createdAt: biRefreshRuns.createdAt, datasetId: biRefreshRuns.datasetId })
    .from(biRefreshRuns)
    .where(and(eq(biRefreshRuns.organizationId, organizationId), ne(biRefreshRuns.status, "skipped"), gte(biRefreshRuns.createdAt, dayAgo)))
    .orderBy(desc(biRefreshRuns.createdAt));
  const accepted = recent.filter((r) => r.status === "requested" || r.status === "succeeded");

  let trigger: BiRefreshTrigger | null = hasNews ? change!.trigger : null;
  if (!trigger && policy.scheduledRefreshHours > 0) {
    const [lastAccepted] = await db
      .select({ createdAt: biRefreshRuns.createdAt })
      .from(biRefreshRuns)
      .where(and(eq(biRefreshRuns.organizationId, organizationId), inArray(biRefreshRuns.status, ["requested", "succeeded"])))
      .orderBy(desc(biRefreshRuns.createdAt))
      .limit(1);
    if (!lastAccepted || now.getTime() - lastAccepted.createdAt.getTime() >= policy.scheduledRefreshHours * 3_600_000) trigger = "schedule";
  }
  if (!trigger) return { kind: "none" };

  const last = recent[0];
  if (last && now.getTime() - last.createdAt.getTime() < policy.minIntervalMinutes * 60_000) return { kind: "throttled", trigger };
  const perDataset = new Map<string, number>();
  for (const r of accepted) if (r.datasetId) perDataset.set(r.datasetId, (perDataset.get(r.datasetId) ?? 0) + 1);
  if ([...perDataset.values()].some((n) => n >= policy.maxRefreshesPerDay)) return { kind: "throttled", trigger };

  return { kind: "enqueue", trigger, watermark: hasNews ? change!.at : null };
}

export function triggerLabel(trigger: BiRefreshTrigger): string {
  return BI_REFRESH_TRIGGER_LABELS[trigger];
}
