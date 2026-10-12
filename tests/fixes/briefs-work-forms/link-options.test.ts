/**
 * Review fix "briefs-work-forms" (truncated option lists): the deadline/task
 * dialog searches every visible process, and the link option lists include the
 * preselected/current process when, and only when, it is visible to the user.
 * P0.6 removed the 1,000-process cap of `listProcessOptions`: the document
 * options list EVERY visible process and `searchProcessOptions` narrows them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLinkOptions } from "@/modules/documents/link-options";
import { searchProcessOptions } from "@/modules/processes/service";
import { listWorkLinkOptions, searchWorkLinkProcesses } from "@/modules/work/service";
import { processWhere } from "@/server/auth/access";
import { legalProcesses } from "@/server/db/schema";
import { ForbiddenError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../../helpers/fixtures";

let fx: Fixture;
const ids: Record<string, string> = {};

type LpInsert = typeof legalProcesses.$inferInsert;

function processRow(number: string, title: string, values: Partial<LpInsert> = {}): LpInsert {
  return { organizationId: fx.orgA, number, title, court: "TRT10", area: "labor", phase: "knowledge", unitId: fx.unitSp, ...values };
}

beforeAll(async () => {
  fx = await setupFixture("bwflinks");
  const old = new Date("2020-01-01T12:00:00Z");
  // Visible to the SP lawyer, not among the 20 most recently updated (quick picks) and sorted after the
  // 1,000 filler processes by number (beyond the old cap of the document options).
  const [target] = await fx.db
    .insert(legalProcesses)
    .values(processRow("9999999-99.2026.5.10.0001", "Processo Alvo Zeta (fictício)", { updatedAt: old }))
    .returning({ id: legalProcesses.id });
  ids.target = target.id;
  // Not visible to the SP lawyer (confidential, other responsible).
  const [hidden] = await fx.db
    .insert(legalProcesses)
    .values(processRow("9999998-99.2026.5.10.0001", "Processo Sigiloso Zeta (fictício)", { isConfidential: true, updatedAt: old }))
    .returning({ id: legalProcesses.id });
  ids.hidden = hidden.id;
  // Filler: 1,000 visible processes with lower numbers, updated after the target.
  const filler: LpInsert[] = [];
  for (let i = 1; i <= 1000; i++) {
    filler.push(processRow(`${String(i).padStart(7, "0")}-11.2026.5.10.0001`, `Processo de volume ${i} (fictício)`));
  }
  await fx.db.insert(legalProcesses).values(filler);
}, 180_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("deadline/task link options (/prazos)", () => {
  it("lists only recent processes as quick picks and adds a visible preselected one", async () => {
    const { lawyer } = fx.ctx;
    const base = await listWorkLinkOptions(lawyer);
    expect(base.processSearch).toBe(true);
    expect(base.processes.length).toBeLessThanOrEqual(20);
    expect(base.processes.map((p) => p.id)).not.toContain(ids.target);

    const withTarget = await listWorkLinkOptions(lawyer, { includeProcessId: ids.target });
    expect(withTarget.processes[0]).toEqual({ id: ids.target, label: "9999999-99.2026.5.10.0001 · Processo Alvo Zeta (fictício)" });

    const withHidden = await listWorkLinkOptions(lawyer, { includeProcessId: ids.hidden });
    expect(withHidden.processes.map((p) => p.id)).not.toContain(ids.hidden);
    // Invalid ids are ignored.
    expect((await listWorkLinkOptions(lawyer, { includeProcessId: "x' or 1=1 --" })).processes).toHaveLength(base.processes.length);
  });

  it("searches every visible process, never an invisible one, and requires deadline/task write", async () => {
    const { lawyer, admin, executive } = fx.ctx;
    const hits = await searchWorkLinkProcesses(lawyer, "Zeta");
    expect(hits).toEqual([{ id: ids.target, label: "9999999-99.2026.5.10.0001 · Processo Alvo Zeta (fictício)", status: "active" }]);
    expect((await searchWorkLinkProcesses(lawyer, "9999999")).map((h) => h.id)).toEqual([ids.target]);
    expect((await searchWorkLinkProcesses(admin, "Zeta")).map((h) => h.id).sort()).toEqual([ids.target, ids.hidden].sort());
    expect(await searchWorkLinkProcesses(lawyer, "Z")).toEqual([]); // under 2 characters
    expect(await searchWorkLinkProcesses(lawyer, 42)).toEqual([]);
    await expect(searchWorkLinkProcesses(executive, "Zeta")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("document link options (/documentos/novo and /documentos/[id])", () => {
  it("lists every visible process (no 1,000 cap) and never an invisible one", async () => {
    const { lawyer } = fx.ctx;
    const visible = await fx.db.select({ id: legalProcesses.id }).from(legalProcesses).where(processWhere(lawyer));
    expect(visible.length).toBeGreaterThan(1000);

    const base = await loadLinkOptions(lawyer);
    const values = base.processes.map((p) => p.value);
    expect(values).toHaveLength(visible.length);
    expect([...values].sort()).toEqual(visible.map((r) => r.id).sort());
    expect(values).toContain(ids.target);
    expect(values).not.toContain(ids.hidden);
    expect(base.processes.find((p) => p.value === ids.target)).toEqual({
      value: ids.target,
      label: "9999999-99.2026.5.10.0001 · Processo Alvo Zeta (fictício)",
    });

    // The preselected/current process is already listed: kept once, nothing added.
    const withTarget = await loadLinkOptions(lawyer, { includeProcessId: ids.target });
    expect(withTarget.processes).toHaveLength(visible.length);
    expect(withTarget.processes.filter((p) => p.value === ids.target)).toHaveLength(1);

    // An invisible preselection is never offered; invalid ids are ignored.
    const withHidden = await loadLinkOptions(lawyer, { includeProcessId: ids.hidden });
    expect(withHidden.processes.map((p) => p.value)).not.toContain(ids.hidden);
    expect(withHidden.processes).toHaveLength(visible.length);
    expect((await loadLinkOptions(lawyer, { includeProcessId: "x' or 1=1 --" })).processes).toHaveLength(visible.length);
  });

  it("narrows the visible processes with the search and keeps only visible selections", async () => {
    const { lawyer, admin } = fx.ctx;
    const byTitle = await searchProcessOptions(lawyer, { q: "Zeta" });
    expect(byTitle).toEqual({
      items: [{ id: ids.target, number: "9999999-99.2026.5.10.0001", title: "Processo Alvo Zeta (fictício)" }],
      total: 1,
      shown: 1,
    });
    expect((await searchProcessOptions(lawyer, { q: "99999999920265100001" })).items.map((p) => p.id)).toEqual([ids.target]);
    expect((await searchProcessOptions(admin, { q: "Zeta" })).items.map((p) => p.id).sort()).toEqual([ids.target, ids.hidden].sort());

    // "mostrando N de M": the page is limited, the total counts every visible match.
    const volume = await searchProcessOptions(lawyer, { q: "volume", limit: 50 });
    expect(volume.total).toBe(1000);
    expect(volume.shown).toBe(50);
    expect(volume.items).toHaveLength(50);

    // A visible selection stays listed even when it does not match; an invisible one never appears.
    const kept = await searchProcessOptions(lawyer, { q: "volume", limit: 50, includeIds: [ids.target, ids.hidden] });
    expect(kept.items.map((p) => p.id)).toContain(ids.target);
    expect(kept.items.map((p) => p.id)).not.toContain(ids.hidden);
    expect(kept.shown).toBe(50);
  });
});
