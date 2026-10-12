import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContingencySettingsForm } from "@/modules/admin/components/contingency-settings-form";
import { EmailIntakeSettingsForm } from "@/modules/admin/components/email-intake-settings-form";
import { UserForm } from "@/modules/admin/components/user-form";
import { groupPermissions } from "@/modules/admin/permission-groups";
import { CompanyForm } from "@/modules/organization/components/company-form";
import { LawFirmForm } from "@/modules/organization/components/law-firm-form";
import { PERMISSIONS } from "@/server/auth/permissions";

/** Server-render smoke tests of the admin forms (no browser available in CI). */

const action = async () => ({ ok: true as const });

describe("admin forms", () => {
  it("user form: external counsel shows the law firm select instead of the unit", () => {
    const base = {
      mode: "edit" as const,
      action,
      units: [{ value: "u1", label: "São Paulo" }],
      lawFirms: [{ value: "f1", label: "Escritório Fictício" }],
      teams: [],
    };
    const external = renderToStaticMarkup(
      createElement(UserForm, {
        ...base,
        defaults: { id: "x", name: "Eva", email: "eva@a.test", role: "external_counsel", unitId: null, lawFirmId: "f1", jobTitle: null, isActive: true, teamIds: [] },
      }),
    );
    expect(external).toContain('name="lawFirmId"');
    expect(external).not.toContain('name="unitId"');
    expect(external).toContain("Escritório externo:");
    const lawyer = renderToStaticMarkup(
      createElement(UserForm, {
        ...base,
        defaults: { id: "y", name: "Laura", email: "laura@a.test", role: "lawyer", unitId: "u1", lawFirmId: null, jobTitle: null, isActive: true, teamIds: [] },
      }),
    );
    expect(lawyer).toContain('name="unitId"');
    expect(lawyer).not.toContain('name="lawFirmId"');
    // All eight roles are described.
    for (const label of ["Contabilidade / controladoria", "Auditoria e compliance", "Escritório externo"]) expect(lawyer).toContain(label);
  });

  it("settings forms render the contingency rules version and the fixed simulated e-mail mode", () => {
    const contingency = renderToStaticMarkup(
      createElement(ContingencySettingsForm, {
        action,
        rulesVersion: 3,
        defaults: { riskRemote: 0, riskPossible: 50, riskProbable: 100, confidenceThreshold: 85, idleGuaranteeDays: 180 },
      }),
    );
    expect(contingency).toContain("versão 3");
    expect(contingency).toContain('name="riskPossible"');
    const email = renderToStaticMarkup(
      createElement(EmailIntakeSettingsForm, {
        action,
        defaults: {
          senderName: "Praetor (simulação)",
          senderAddress: "nao-responda@praetor.invalid",
          notifyOnBriefReady: true,
          notifyOnAssignment: true,
          autoAssign: true,
          autoGenerateBrief: true,
          autoNotify: true,
        },
      }),
    );
    expect(email).toContain("Simulado — fixo nesta versão");
    expect(email).toContain("nenhuma mensagem");
    expect(email).toContain('name="autoGenerateBrief"');
  });

  it("company and law firm forms render", () => {
    expect(renderToStaticMarkup(createElement(CompanyForm, { mode: "create", action }))).toContain('name="document"');
    expect(
      renderToStaticMarkup(
        createElement(LawFirmForm, {
          mode: "edit",
          action,
          defaults: { id: "f", name: "Escritório", document: null, contactName: null, contactEmail: null, isActive: true },
        }),
      ),
    ).toContain('name="contactEmail"');
  });

  it("groups every permission of the matrix (nothing hidden)", () => {
    const groups = groupPermissions(PERMISSIONS);
    expect(groups.flatMap((g) => g.permissions).sort()).toEqual([...PERMISSIONS].sort());
    expect(groups.find((g) => g.key === "outras")).toBeUndefined();
    expect(groups.find((g) => g.key === "contingencias")?.permissions).toEqual(
      expect.arrayContaining(["contingency:read", "snapshot:close", "import:run", "report:read"]),
    );
  });
});
