/**
 * P0.6 (deferred 22, work part): the responsible / assignee options of the work
 * module follow the user directory of access.ts (rule 10). External counsel see
 * themselves, their law firm and the responsible people of the processes they can
 * see; never the internal staff. Picking someone outside that list by id is refused.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTask, listWorkUserOptions } from "@/modules/work/service";
import { legalProcesses, users } from "@/server/db/schema";
import { ValidationError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;
let firmProcess: string;
let colleagueId: string;
let otherFirmProcessResponsible: string;

beforeAll(async () => {
  f = await setupFixture("p06-workopt");
  const { admin, lawyerRe, lawyer } = f.ctx;
  // A process of law firm A, with an internal lawyer (RE) as responsible.
  firmProcess = await makeProcess(admin, { title: "Processo do escritório (fictício)", unitId: f.unitRe });
  await f.db.update(legalProcesses).set({ lawFirmId: f.lawFirmA, responsibleId: lawyerRe.userId }).where(eq(legalProcesses.id, firmProcess));
  // An internal process the external counsel cannot see, with the SP lawyer as responsible.
  const internal = await makeProcess(admin, { title: "Processo interno (fictício)", unitId: f.unitSp });
  await f.db.update(legalProcesses).set({ responsibleId: lawyer.userId }).where(eq(legalProcesses.id, internal));
  otherFirmProcessResponsible = lawyer.userId!;
  // A colleague of the same law firm.
  const [colleague] = await f.db
    .insert(users)
    .values({
      organizationId: f.orgA,
      name: "Caio Colega do Escritório",
      email: "p06-workopt.colega@a.test",
      passwordHash: "x",
      role: "external_counsel",
      lawFirmId: f.lawFirmA,
    })
    .returning();
  colleagueId = colleague.id;
}, 120_000);

afterAll(async () => {
  await f?.teardown();
});

describe("work user options", () => {
  it("external counsel: themselves, their law firm and the responsible people of their processes", async () => {
    const { externalCounsel, lawyerRe, manager, analyst, executive, admin } = f.ctx;
    const ids = (await listWorkUserOptions(externalCounsel)).map((u) => u.id).sort();
    expect(ids).toEqual([externalCounsel.userId!, colleagueId, lawyerRe.userId!].sort());
    for (const internal of [manager, analyst, executive, admin]) expect(ids).not.toContain(internal.userId);
    expect(ids).not.toContain(otherFirmProcessResponsible);
  });

  it("internal roles keep the whole directory of active users", async () => {
    const ids = (await listWorkUserOptions(f.ctx.lawyer)).map((u) => u.id);
    for (const u of [f.ctx.manager, f.ctx.analyst, f.ctx.externalCounsel, f.ctx.lawyerRe]) expect(ids).toContain(u.userId);
    expect(ids).toContain(colleagueId);
    expect(ids).not.toContain(f.ctx.adminB.userId);
  });

  it("external counsel cannot assign a task to internal staff outside the list", async () => {
    const { externalCounsel, manager, lawyerRe } = f.ctx;
    const err = await createTask(externalCounsel, { title: "Tarefa fictícia", processId: firmProcess, assigneeId: manager.userId! }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors?.assigneeId).toBeDefined();
    const ok = await createTask(externalCounsel, { title: "Tarefa fictícia", processId: firmProcess, assigneeId: lawyerRe.userId! });
    expect(ok.id).toBeTruthy();
  });
});
