/**
 * P0.6 (deferred 20): the daily digest and the workload panel count preliminary
 * analyses awaiting review with the same rule as the review queue: a version
 * superseded by a newer generated version (with content) of the same process is
 * not pending work. A newer version still generating (no content) does not
 * supersede the previous one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCaseBriefs } from "@/modules/briefs/service";
import { getWorkload } from "@/modules/distribution/service";
import { buildDailyDigestData } from "@/modules/emails/service";
import type { StoredCaseBrief } from "@/domain/case-brief";
import { caseBriefs } from "@/server/db/schema";
import { makeProcess, setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;
const content = { summary: "Conteúdo fictício.", contradictions: [], missingDocuments: [], urgencies: [] } as unknown as StoredCaseBrief;

beforeAll(async () => {
  f = await setupFixture("p06-briefs");
  const { admin } = f.ctx;
  const p1 = await makeProcess(admin, { title: "Duas versões prontas (fictício)", unitId: f.unitSp });
  const p2 = await makeProcess(admin, { title: "Nova versão ainda gerando (fictício)", unitId: f.unitSp });
  const p3 = await makeProcess(admin, { title: "Versão nova rejeitada (fictício)", unitId: f.unitSp });
  const brief = { organizationId: f.orgA, mode: "demo" as const, provider: "simulated", model: "regras", promptVersion: "v1", inputHash: "h" };
  await f.db.insert(caseBriefs).values([
    // p1: v1 is superseded by v2 (with content): only v2 awaits review.
    { ...brief, processId: p1, version: 1, status: "ready_for_review", content },
    { ...brief, processId: p1, version: 2, status: "ready_for_review", content },
    // p2: v2 is still generating (no content): v1 is still the version to review.
    { ...brief, processId: p2, version: 1, status: "in_review", content },
    { ...brief, processId: p2, version: 2, status: "generating" },
    // p3: v2 was generated and rejected: v1 is superseded all the same.
    { ...brief, processId: p3, version: 1, status: "in_review", content },
    { ...brief, processId: p3, version: 2, status: "rejected", content },
  ]);
}, 120_000);

afterAll(async () => {
  await f?.teardown();
});

describe("superseded preliminary-analysis versions are not pending review", () => {
  it("daily digest counts match the review queue", async () => {
    const { manager } = f.ctx;
    const digest = await buildDailyDigestData(manager);
    const ready = digest.items.find((i) => i.label === "Análises preliminares prontas para revisão")?.count;
    const inReview = digest.items.find((i) => i.label === "Análises preliminares em revisão (aguardando aprovação)")?.count;
    expect(ready).toBe(1);
    expect(inReview).toBe(1);
    expect((await listCaseBriefs(manager, { status: "ready_for_review" })).total).toBe(ready);
    expect((await listCaseBriefs(manager, { status: "in_review" })).total).toBe(inReview);
  });

  it("workload counts only the version to review of each process", async () => {
    const workload = await getWorkload(f.ctx.manager);
    expect(workload.totals.pending.briefsAwaitingReview).toBe(2);
    const internal = workload.byLawFirm.find((r) => r.key === "none");
    expect(internal?.pending.briefsAwaitingReview).toBe(2);
  });
});
