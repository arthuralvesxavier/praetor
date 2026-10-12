/**
 * Regression (review: "portfolio_alerts routine upserts one alert at a time
 * and fails above 65,535 keep keys").
 *
 * - `resolveStaleAlerts` / `resolveAlertsByDedupeKeys` bind the key list as ONE
 *   jsonb parameter, so lists above the 65,535-parameter limit of the
 *   PostgreSQL wire protocol work.
 * - `upsertAlert` does not rewrite an open alert whose content is unchanged.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAlertsByDedupeKeys, resolveStaleAlerts, upsertAlert } from "@/modules/alerts/service";
import type { Database } from "@/server/db/client";
import { alerts, organizations } from "@/server/db/schema";
import { createTestDatabase } from "../../helpers/db";

let db: Database;
let close: () => Promise<void>;
let orgId: string;

const KEEP_COUNT = 70_000;

async function openKeys(): Promise<string[]> {
  const rows = await db
    .select({ key: alerts.dedupeKey })
    .from(alerts)
    .where(and(eq(alerts.organizationId, orgId), isNull(alerts.resolvedAt)));
  return rows.map((r) => r.key).sort();
}

function alert(key: string, title = `Alerta ${key} (fictício)`) {
  return {
    organizationId: orgId,
    type: "valuation_pending_review" as const,
    severity: "warning" as const,
    title,
    message: "Mensagem de teste (fictícia).",
    entityType: "legal_process" as const,
    entityId: randomUUID(),
    dedupeKey: key,
  };
}

async function xminOf(key: string): Promise<string> {
  const rows = await db.execute<{ xmin: string }>(
    sql`select xmin::text as xmin from alerts where organization_id = ${orgId} and dedupe_key = ${key} and resolved_at is null`,
  );
  const list = (Array.isArray(rows) ? rows : (rows as { rows: { xmin: string }[] }).rows) as { xmin: string }[];
  return list[0].xmin;
}

beforeAll(async () => {
  ({ db, close } = await createTestDatabase());
  const [org] = await db.insert(organizations).values({ name: "Organização de escala (fictícia)", slug: "fix-alert-scale" }).returning();
  orgId = org.id;
}, 120_000);

afterAll(async () => {
  await close?.();
});

describe("alerts at scale", () => {
  it("resolveStaleAlerts accepts more than 65,535 keep keys", async () => {
    for (const key of ["keep:1", "keep:69999", "stale:1", "stale:2"]) await upsertAlert(alert(key));
    const keep = Array.from({ length: KEEP_COUNT }, (_, i) => `keep:${i}`);
    const resolved = await resolveStaleAlerts(orgId, ["valuation_pending_review"], keep);
    expect(resolved).toBe(2);
    expect(await openKeys()).toEqual(["keep:1", "keep:69999"]);
  }, 60_000);

  it("resolveStaleAlerts with an empty keep list resolves every open alert of the types", async () => {
    await upsertAlert(alert("stale:3"));
    const resolved = await resolveStaleAlerts(orgId, ["valuation_pending_review"], []);
    expect(resolved).toBe(3);
    expect(await openKeys()).toEqual([]);
  });

  it("resolveAlertsByDedupeKeys accepts more than 65,535 keys and keys with quotes", async () => {
    await upsertAlert(alert(`odd:"quoted"\\key`));
    await upsertAlert(alert("by-key:65000"));
    await upsertAlert(alert("other"));
    const keys = Array.from({ length: KEEP_COUNT }, (_, i) => `by-key:${i}`);
    keys.push(`odd:"quoted"\\key`);
    expect(await resolveAlertsByDedupeKeys(orgId, keys)).toBe(2);
    expect(await openKeys()).toEqual(["other"]);
  }, 60_000);

  it("upsertAlert does not rewrite an unchanged open alert, and refreshes a changed one", async () => {
    await upsertAlert(alert("stable", "Título estável (fictício)"));
    const before = await xminOf("stable");
    await upsertAlert(alert("stable", "Título estável (fictício)"));
    expect(await xminOf("stable")).toBe(before);

    await upsertAlert({ ...alert("stable", "Título novo (fictício)"), severity: "critical" });
    expect(await xminOf("stable")).not.toBe(before);
    const [row] = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.organizationId, orgId), eq(alerts.dedupeKey, "stable"), isNull(alerts.resolvedAt)));
    expect(row.title).toBe("Título novo (fictício)");
    expect(row.severity).toBe("critical");
  });
});
