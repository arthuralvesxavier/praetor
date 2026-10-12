import { describe, expect, it } from "vitest";
import {
  LEGACY_PROCESS_PHASES,
  PROCESS_INSTANCE_LABELS,
  PROCESS_INSTANCES,
  PROCESS_PHASE_LABELS,
  PROCESS_PHASES,
  isProcessPhase,
  processPhaseLabel,
} from "@/domain/enums";
import { optionsFromLabels } from "@/lib/options";
import { BI_LABEL_DOMAINS } from "@/modules/bi/labels";
import { actionLabel, formatChangeValue } from "@/modules/admin/history-format";
import { parsePhase } from "@/modules/imports/parser";
import { withoutLegacyPhase } from "@/modules/imports/plan";
import { processFiltersFromSearchParams } from "@/modules/processes/filters";
import { processFiltersSchema, processInstanceInputSchema, updateProcessSchema } from "@/modules/processes/schemas";

/**
 * P0.5 — fase e instância são eixos distintos. Fase: conhecimento, liquidação, execução.
 * Instância: 1º, 2º e 3º grau. As fases do modelo anterior só são exibidas em registros
 * históricos e nunca são oferecidas para gravação nem em filtros.
 */
describe("phase and instance are distinct axes (P0.5)", () => {
  it("has exactly three phases and three instances, labeled in pt-BR", () => {
    expect(PROCESS_PHASES).toEqual(["knowledge", "liquidation", "enforcement"]);
    expect(PROCESS_PHASE_LABELS).toEqual({ knowledge: "Conhecimento", liquidation: "Liquidação", enforcement: "Execução" });
    expect(PROCESS_INSTANCES).toEqual(["first", "second", "superior"]);
    expect(PROCESS_INSTANCE_LABELS).toEqual({ first: "1º grau", second: "2º grau", superior: "3º grau" });
    expect(optionsFromLabels(PROCESS_PHASE_LABELS).map((o) => o.label)).toEqual(["Conhecimento", "Liquidação", "Execução"]);
  });

  it("never offers a legacy phase for writes or filters", () => {
    for (const legacy of LEGACY_PROCESS_PHASES) {
      expect(isProcessPhase(legacy)).toBe(false);
      expect(updateProcessSchema.safeParse({ phase: legacy }).success).toBe(false);
      expect(processInstanceInputSchema.safeParse({ instance: "second", court: "TRT10", phase: legacy }).success).toBe(false);
      expect(processFiltersSchema.safeParse({ phase: legacy }).success).toBe(false);
      expect(processFiltersFromSearchParams({ phase: legacy }).phase).toBeUndefined();
    }
    expect(processFiltersFromSearchParams({ phase: "liquidation", instancia: "superior" })).toMatchObject({
      phase: "liquidation",
      instance: "superior",
    });
  });

  it("keeps the legacy labels only to display historical rows (closed competências, audit, BI)", () => {
    expect(processPhaseLabel("appeal")).toBe("Recursal");
    expect(processPhaseLabel("pre_filing")).toBe("Pré-ajuizamento");
    expect(processPhaseLabel("settlement")).toBe("Acordo em andamento");
    expect(processPhaseLabel("closed")).toBe("Encerrado");
    expect(processPhaseLabel("enforcement")).toBe("Execução");
    expect(processPhaseLabel(null)).toBeNull();
    expect(formatChangeValue("phase", "appeal", "legal_process")).toBe("Recursal");
    expect(BI_LABEL_DOMAINS.process_phase.appeal).toBe("Recursal");
    expect(actionLabel("legal_process.phase_migration")).not.toBe("legal_process.phase_migration");
    expect(actionLabel("legal_process.phase_migration_rollback")).not.toBe("legal_process.phase_migration_rollback");
  });

  it("an import rollback never writes back a legacy phase recorded before the split", () => {
    expect(withoutLegacyPhase({ phase: "appeal", instance: null, city: "Palmas" })).toEqual({ instance: null, city: "Palmas" });
    expect(withoutLegacyPhase({ phase: "liquidation", city: null })).toEqual({ phase: "liquidation", city: null });
    expect(withoutLegacyPhase({ city: "Palmas" })).toEqual({ city: "Palmas" });
    expect(withoutLegacyPhase(null)).toBeNull();
  });

  it("maps 'recurso' to the INSTANCE, never to the phase", () => {
    const recurso = parsePhase("Recurso ordinário em tramitação");
    expect(recurso).toMatchObject({ phase: null, instance: "second", recognized: true });
    expect(parsePhase("AIRR — aguardando julgamento no TST")).toMatchObject({ phase: null, instance: "superior" });
    expect(parsePhase("Execução — agravo de petição pendente")).toMatchObject({ phase: "enforcement", instance: "second" });
    expect(parsePhase("Liquidação — recurso de revista interposto")).toMatchObject({ phase: "liquidation", instance: "superior" });
  });
});
