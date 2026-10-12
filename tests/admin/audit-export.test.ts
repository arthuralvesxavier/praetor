import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_CSV_HEADERS, buildAuditCsv, csvCell, formatChangesForCsv } from "@/modules/admin/audit-csv";
import { actionLabel, formatChangeValue } from "@/modules/admin/history-format";
import { exportAuditLogs, listAuditLogs } from "@/modules/admin/service";
import { auditLogs } from "@/server/db/schema";
import { ForbiddenError } from "@/server/lib/errors";
import { setupFixture, type Fixture } from "../helpers/fixtures";

describe("audit CSV (pure)", () => {
  it("uses BOM, ';', CRLF, quoting and neutralizes formulas", () => {
    expect(csvCell("simples")).toBe("simples");
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('diz "olá"')).toBe('"diz ""olá"""');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("+55 11")).toBe("'+55 11");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell(null)).toBe("");

    const csv = buildAuditCsv(
      [
        {
          createdAt: new Date("2026-10-11T13:05:00Z"),
          actorName: "Ana Admin",
          action: "legal_process.view_confidential",
          entityType: "legal_process",
          entityId: "3f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
          summary: "Processo sigiloso consultado; detalhe",
          changes: null,
          ipAddress: "10.0.0.1",
          refNames: {},
        },
        {
          createdAt: new Date("2026-10-10T12:00:00Z"),
          actorName: null,
          action: "organization.contingency_settings_update",
          entityType: "organization",
          entityId: null,
          summary: "Parâmetros alterados",
          changes: { riskPercentPossible: { from: 50, to: 40 }, rulesVersion: { from: 1, to: 2 } },
          ipAddress: null,
          refNames: {},
        },
      ],
      { truncatedNote: "Exportação limitada." },
    );
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(AUDIT_CSV_HEADERS.join(";"));
    expect(lines[1]).toContain("11/10/2026 10:05"); // America/Sao_Paulo
    expect(lines[1]).toContain(";Acesso a processo sigiloso;legal_process.view_confidential;Processo;");
    expect(lines[1]).toContain('"Processo sigiloso consultado; detalhe"');
    expect(lines[2]).toContain(";Sistema;");
    expect(lines[2]).toContain("Percentual de provisão — possível: 50% → 40% | Versão das regras de risco: 1 → 2");
    expect(lines[3]).toBe("Exportação limitada.");
    expect(lines[4]).toBe("");
  });

  it("labels the v2 actions and fields", () => {
    expect(actionLabel("company.create")).toBe("Empresa cadastrada");
    expect(actionLabel("law_firm.deactivate")).toBe("Escritório externo desativado");
    expect(actionLabel("audit.export")).toBe("Exportação da trilha de auditoria");
    expect(actionLabel("valuation.approve")).toBe("Aprovação · Valoração");
    expect(actionLabel("case_brief.generate")).toBe("Geração · Análise preliminar");
    expect(actionLabel("import_batch.rollback")).toBe("Desfazimento · Importação de planilha");
    expect(formatChangeValue("riskPercentageBp", 5000, "legal_process")).toBe("50%");
    expect(formatChangeValue("instance", "second", "legal_process")).toBe("2º grau");
    expect(formatChangeValue("status", "homologated", "settlement")).toBe("Homologado");
    expect(formatChangeValue("closureReason", "lost_patronage", "legal_process")).toBe("Saída do acervo / perda do patrocínio");
    expect(formatChangesForCsv({ liquidatedAmountCents: { from: null, to: 123456 } }, "legal_process", {})).toMatch(
      /^Valor liquidado \/ apurado: \(vazio\) → R\$\s1\.234,56$/,
    );
  });
});

describe("exportAuditLogs", () => {
  let fx: Fixture;

  beforeAll(async () => {
    fx = await setupFixture("auditexp");
    const entry = (orgId: string, action: string, summary: string, createdAt: Date) => ({
      organizationId: orgId,
      actorId: null,
      action,
      entityType: "legal_process" as const,
      entityId: null,
      summary,
      createdAt,
    });
    await fx.db.insert(auditLogs).values([
      entry(fx.orgA, "legal_process.view_confidential", "Processo sigiloso consultado", new Date("2026-10-01T12:00:00Z")),
      entry(fx.orgA, "legal_process.view_confidential", "Processo sigiloso consultado", new Date("2026-10-05T12:00:00Z")),
      entry(fx.orgA, "legal_process.update", "Processo alterado", new Date("2026-10-05T13:00:00Z")),
      entry(fx.orgB, "legal_process.view_confidential", "Processo sigiloso da organização B", new Date("2026-10-05T12:00:00Z")),
    ]);
  });

  afterAll(async () => fx.teardown());

  it("requires audit:read (auditor and manager can, lawyer and executive cannot)", async () => {
    await expect(exportAuditLogs(fx.ctx.lawyer)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(exportAuditLogs(fx.ctx.executive)).rejects.toBeInstanceOf(ForbiddenError);
    const viaAuditor = await exportAuditLogs(fx.ctx.auditor, { action: "legal_process.view_confidential" });
    expect(viaAuditor.items).toHaveLength(2);
  });

  it("applies the filters, stays inside the organization and records the export", async () => {
    const all = await exportAuditLogs(fx.ctx.manager, { action: "legal_process.view_confidential" });
    expect(all.items.map((i) => i.summary)).toEqual(["Processo sigiloso consultado", "Processo sigiloso consultado"]);
    expect(all.truncated).toBe(false);

    const ranged = await exportAuditLogs(fx.ctx.manager, { action: "legal_process.view_confidential", from: "2026-10-03", to: "2026-10-31" });
    expect(ranged.items).toHaveLength(1);

    const b = await exportAuditLogs(fx.ctx.adminB, { action: "legal_process.view_confidential" });
    expect(b.items.map((i) => i.summary)).toEqual(["Processo sigiloso da organização B"]);

    const exports = await fx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, fx.orgA), eq(auditLogs.action, "audit.export")));
    expect(exports.length).toBe(3); // auditor + 2 manager exports
    expect(exports.find((e) => e.actorId === fx.ctx.manager.userId)?.metadata).toMatchObject({
      filters: { action: "legal_process.view_confidential" },
    });

    // The confidential-access filter of the audit page uses the same action id.
    const page = await listAuditLogs(fx.ctx.manager, { action: "legal_process.view_confidential" });
    expect(page.total).toBe(2);
  });
});
