import { describe, expect, it } from "vitest";
import { actionLabel, fieldLabel, formatChangeValue } from "@/modules/admin/history-format";

describe("history formatting", () => {
  it("labels fields and actions in pt-BR with safe fallbacks", () => {
    expect(fieldLabel("riskLevel")).toBe("Risco");
    expect(fieldLabel("somethingNew")).toBe("somethingNew");
    expect(actionLabel("user.create")).toBe("Usuário criado");
    expect(actionLabel("legal_process.update")).toBe("Alteração · Processo");
    expect(actionLabel("contract.delete")).toBe("Exclusão · Contrato");
    expect(actionLabel("custom.weird_action")).toBe("custom.weird_action");
  });

  it("formats values by field and entity type", () => {
    expect(formatChangeValue("status", "active", "legal_process")).toBe("Ativo");
    expect(formatChangeValue("status", "open", "occurrence")).toBe("Aberta");
    expect(formatChangeValue("role", "legal_manager", "user")).toBe("Gestor jurídico");
    expect(formatChangeValue("isConfidential", true, "contract")).toBe("Sim");
    expect(formatChangeValue("title", null, "contract")).toBe("(vazio)");
    expect(formatChangeValue("dueDate", "2026-03-05", "deadline")).toBe("05/03/2026");
    expect(formatChangeValue("valueCents", 123456, "contract")).toMatch(/1\.234,56/);
    const id = "3f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";
    expect(formatChangeValue("responsibleId", id, "contract", { [id]: "Camila Rocha" })).toBe("Camila Rocha");
    expect(formatChangeValue("processId", id, "deadline")).toBe("registro vinculado");
    expect(formatChangeValue("teamIds", [id], "user", { [id]: "Contencioso" })).toBe("Contencioso");
    expect(formatChangeValue("teamIds", [], "user")).toBe("(nenhum)");
  });
});
