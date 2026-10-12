import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadShellData } from "@/components/layout/shell-data";
import { computeCnjCheckDigit } from "@/domain/cnj";
import { upsertAlert } from "@/modules/alerts/service";
import type { AuthContext } from "@/server/auth/context";
import { lawFirms } from "@/server/db/schema";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

let seq = 4100;
function cnj(): string {
  seq += 1;
  const parts = { sequence: String(seq).padStart(7, "0"), year: 2026, segment: "5", tribunal: "10", origin: "0011" };
  return `${parts.sequence}-${computeCnjCheckDigit(parts)}.${parts.year}.${parts.segment}.${parts.tribunal}.${parts.origin}`;
}

describe("loadShellData (app header and user menu)", () => {
  let fx: Fixture;
  let firmB: string;

  beforeAll(async () => {
    fx = await setupFixture("shell-data");
    const { manager } = fx.ctx;
    const [b] = await fx.db
      .insert(lawFirms)
      .values({ organizationId: fx.orgB, name: "Escritório da Organização B (fictício)" })
      .returning();
    firmB = b.id;

    const sp = await makeProcess(manager, { number: cnj(), unitId: fx.unitSp, title: "Processo SP do cabeçalho" });
    const re = await makeProcess(manager, { number: cnj(), unitId: fx.unitRe, title: "Processo RE do cabeçalho" });
    const firm = await makeProcess(manager, {
      number: cnj(),
      lawFirmId: fx.lawFirmA,
      title: "Processo do escritório A",
    });
    const secret = await makeProcess(manager, {
      number: cnj(),
      unitId: fx.unitSp,
      isConfidential: true,
      title: "Processo sigiloso do cabeçalho",
    });

    const alert = (entityId: string, severity: "critical" | "warning" | "info", key: string) =>
      upsertAlert({
        organizationId: fx.orgA,
        type: "process_needs_verification",
        severity,
        title: "Alerta de teste (fictício)",
        message: "Mensagem de teste.",
        entityType: "legal_process",
        entityId,
        dedupeKey: `shell-test:${key}`,
      });
    await alert(sp, "critical", "sp");
    await alert(re, "warning", "re");
    await alert(firm, "warning", "firm");
    await alert(secret, "critical", "secret");
  });

  afterAll(async () => {
    await fx?.teardown();
  });

  it("returns the organization, unit and role context of the user", async () => {
    const data = await loadShellData(fx.ctx.lawyer);
    expect(data.organizationName).toBe("Organização A (fictícia)");
    expect(data.unitName).toBe("São Paulo");
    expect(data.lawFirmName).toBeNull();
    expect(data.aiMode).toBe("demo");
  });

  it("shows the law firm only for external counsel", async () => {
    const data = await loadShellData(fx.ctx.externalCounsel);
    expect(data.lawFirmName).toBe("Escritório Fictício A Advogados");
    expect(data.unitName).toBeNull();

    // A lawFirmId on a non external-counsel context is ignored.
    const admin: AuthContext = { ...fx.ctx.admin, lawFirmId: fx.lawFirmA };
    expect((await loadShellData(admin)).lawFirmName).toBeNull();
  });

  it("never resolves a law firm or unit of another organization", async () => {
    const forged: AuthContext = { ...fx.ctx.externalCounsel, lawFirmId: firmB };
    expect((await loadShellData(forged)).lawFirmName).toBeNull();

    const foreignUnit: AuthContext = { ...fx.ctx.lawyer, unitId: fx.unitB };
    expect((await loadShellData(foreignUnit)).unitName).toBeNull();
  });

  it("counts open alerts with the row visibility of each user", async () => {
    expect((await loadShellData(fx.ctx.admin)).alerts).toEqual({ total: 4, critical: 2 });
    expect((await loadShellData(fx.ctx.manager)).alerts).toEqual({ total: 4, critical: 2 });
    // Lawyer SP: own unit (non-confidential) + processes without unit; RE and the confidential one are hidden.
    const lawyer = (await loadShellData(fx.ctx.lawyer)).alerts;
    expect(lawyer).toEqual({ total: 2, critical: 1 });
    const lawyerRe = (await loadShellData(fx.ctx.lawyerRe)).alerts;
    expect(lawyerRe).toEqual({ total: 2, critical: 0 });
    // Executive: every non-confidential record.
    expect((await loadShellData(fx.ctx.executive)).alerts).toEqual({ total: 3, critical: 1 });
    // External counsel: only the process of their law firm.
    expect((await loadShellData(fx.ctx.externalCounsel)).alerts).toEqual({ total: 1, critical: 0 });
  });

  it("isolates organizations", async () => {
    const data = await loadShellData(fx.ctx.adminB);
    expect(data.organizationName).toBe("Organização B (fictícia)");
    expect(data.alerts).toEqual({ total: 0, critical: 0 });
  });

  it("shows the simulated e-mail badge only to users with email:read", async () => {
    expect((await loadShellData(fx.ctx.lawyer)).emailMode).toBe("simulated");
    expect((await loadShellData(fx.ctx.auditor)).emailMode).toBe("simulated");
    expect((await loadShellData(fx.ctx.externalCounsel)).emailMode).toBe("simulated");
    expect((await loadShellData(fx.ctx.accountant)).emailMode).toBeNull();
    expect((await loadShellData(fx.ctx.executive)).emailMode).toBeNull();
  });
});
