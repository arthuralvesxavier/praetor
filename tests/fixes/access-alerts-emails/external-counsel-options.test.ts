/**
 * Regression (review: "External counsel sees every law firm, internal user,
 * unit and company in filter dropdowns" / "receives the organization's user
 * directory and the names of all other law firms").
 *
 * access.ts rule 10: option lists are scoped at the service, so every page
 * and form that uses them is covered. External counsel receives only their own
 * law firm, and as users only their firm's colleagues plus the responsible
 * people of the processes (and hearings) they can see. Internal roles keep
 * the full lists.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDaysISO, todayISO } from "@/lib/format";
import { listUserOptions } from "@/modules/admin/service";
import { createHearing, listHearingUserOptions } from "@/modules/hearings/service";
import { listLawFirmOptions } from "@/modules/organization/service";
import type { AuthContext } from "@/server/auth/context";
import { lawFirms, users } from "@/server/db/schema";
import { makeProcess, setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;
const ids: Record<string, string> = {};

const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();

beforeAll(async () => {
  f = await setupFixture("fix-ec-options");
  const { manager, lawyer } = f.ctx;

  const [rival] = await f.db
    .insert(lawFirms)
    .values({ organizationId: f.orgA, name: "Escritório Concorrente (fictício)" })
    .returning();
  ids.rivalFirm = rival.id;
  await f.db.insert(users).values([
    {
      organizationId: f.orgA,
      name: "Caio Colega do Escritório A",
      email: "fix-ec-options.colega@a.test",
      passwordHash: "x",
      role: "external_counsel",
      lawFirmId: f.lawFirmA,
    },
    {
      organizationId: f.orgA,
      name: "Rui Escritório Concorrente",
      email: "fix-ec-options.rival@a.test",
      passwordHash: "x",
      role: "external_counsel",
      lawFirmId: rival.id,
    },
  ]);

  // Process of firm A whose responsible is the internal SP lawyer.
  ids.firmProcess = await makeProcess(manager, {
    title: "Processo do escritório A (fictício)",
    lawFirmId: f.lawFirmA,
    responsibleId: lawyer.userId,
  });
  // Process of the rival firm, responsible = RE lawyer: invisible to firm A.
  await makeProcess(manager, {
    title: "Processo do escritório concorrente (fictício)",
    lawFirmId: rival.id,
    responsibleId: f.ctx.lawyerRe.userId,
  });
  // Hearing of the firm process whose responsible is the legal manager.
  await createHearing(manager, {
    processId: ids.firmProcess,
    kind: "initial",
    mode: "virtual",
    date: addDaysISO(todayISO(), 4),
    time: "15:00",
    location: "Sala virtual fictícia",
    responsibleId: manager.userId,
  });
}, 180_000);

afterAll(async () => {
  await f?.teardown();
});

describe("option lists for external counsel", () => {
  it("law firms: only their own firm; internal roles see every active firm", async () => {
    expect(names(await listLawFirmOptions(f.ctx.externalCounsel))).toEqual(["Escritório Fictício A Advogados"]);
    expect(names(await listLawFirmOptions(f.ctx.lawyer))).toEqual([
      "Escritório Concorrente (fictício)",
      "Escritório Fictício A Advogados",
    ]);
    const noFirm: AuthContext = { ...f.ctx.externalCounsel, lawFirmId: null };
    expect(await listLawFirmOptions(noFirm)).toEqual([]);
  });

  it("users: their firm and the responsible people of visible processes, never the internal staff", async () => {
    const ec = names(await listUserOptions(f.ctx.externalCounsel));
    expect(ec).toEqual(
      ["Caio Colega do Escritório A", "Eva Escritório Externo", "Laura Advogada SP"].sort(),
    );
    const lawyer = names(await listUserOptions(f.ctx.lawyer));
    for (const n of ["Ana Admin", "Rafael Advogado RE", "Rui Escritório Concorrente", "Eva Escritório Externo"]) {
      expect(lawyer).toContain(n);
    }
  });

  it("hearing responsibles: same scope plus the responsible people of visible hearings", async () => {
    const ec = names(await listHearingUserOptions(f.ctx.externalCounsel));
    expect(ec).toEqual(
      ["Caio Colega do Escritório A", "Eva Escritório Externo", "Gustavo Gestor", "Laura Advogada SP"].sort(),
    );
    expect(ec).not.toContain("Ana Admin");
    expect(ec).not.toContain("Rafael Advogado RE");
    expect(ec).not.toContain("Rui Escritório Concorrente");

    const lawyer = names(await listHearingUserOptions(f.ctx.lawyer));
    for (const n of ["Ana Admin", "Rafael Advogado RE", "Rui Escritório Concorrente", "Gustavo Gestor"]) {
      expect(lawyer).toContain(n);
    }
  });
});
