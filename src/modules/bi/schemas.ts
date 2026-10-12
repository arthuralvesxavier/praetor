import { z } from "zod";

/**
 * Contratos de entrada do módulo de painéis Power BI (client-safe).
 * Ids do Power BI são GUIDs (8-4-4-4-12); `z.guid()` aceita qualquer versão.
 */

export const BI_MAX_REPORTS = 20;
/** Validade do token de incorporação (minutos). A página renova antes de expirar. */
export const BI_EMBED_TOKEN_MINUTES = 20;
export const DEFAULT_BI_RLS_ROLE = "AcessoPraetor";

const guid = (message: string) => z.guid({ error: message });

export const biReportSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome do painel.").max(80, "Use no máximo 80 caracteres."),
  id: guid("Informe o id do relatório (GUID copiado do endereço do relatório no Power BI)."),
  datasetId: guid("Informe o id do conjunto de dados (GUID)."),
});

export const biSettingsSchema = z
  .object({
    workspaceId: guid("Informe o id do workspace (GUID copiado do endereço do workspace no Power BI).").nullable(),
    rlsRole: z
      .string()
      .trim()
      .min(1, "Informe o nome do papel de segurança (RLS) criado no Power BI Desktop.")
      .max(80, "Use no máximo 80 caracteres.")
      .regex(/^[\p{L}\p{N} _.-]+$/u, "Use apenas letras, números, espaço, ponto, hífen ou sublinhado."),
    autoRefresh: z.boolean(),
    reports: z.array(biReportSchema).max(BI_MAX_REPORTS, `Cadastre no máximo ${BI_MAX_REPORTS} painéis.`),
  })
  .superRefine((v, ctx) => {
    if (v.reports.length > 0 && !v.workspaceId) {
      ctx.addIssue({ code: "custom", path: ["workspaceId"], message: "Informe o workspace dos painéis cadastrados." });
    }
    const seen = new Set<string>();
    v.reports.forEach((r, i) => {
      const key = r.id.toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["reports", i, "id"], message: "Relatório repetido." });
      seen.add(key);
    });
  });

export type BiSettingsInput = z.input<typeof biSettingsSchema>;
export type BiSettingsData = z.output<typeof biSettingsSchema>;

export const embedReportParamSchema = guid("Relatório inválido.");

/** Reads the settings form (repeated `reportName` / `reportId` / `reportDatasetId` fields, one per row). */
export function biSettingsFromFormData(fd: FormData): BiSettingsInput {
  const text = (key: string) => fd.getAll(key).map((v) => (typeof v === "string" ? v.trim() : ""));
  const names = text("reportName");
  const ids = text("reportId");
  const datasets = text("reportDatasetId");
  const rows = Math.max(names.length, ids.length, datasets.length);
  const reports: BiSettingsInput["reports"] = [];
  for (let i = 0; i < rows; i++) {
    const row = { name: names[i] ?? "", id: ids[i] ?? "", datasetId: datasets[i] ?? "" };
    if (row.name || row.id || row.datasetId) reports.push(row);
  }
  const workspace = fd.get("workspaceId");
  const role = fd.get("rlsRole");
  return {
    workspaceId: typeof workspace === "string" && workspace.trim() ? workspace.trim() : null,
    rlsRole: typeof role === "string" ? role : "",
    autoRefresh: ["on", "true", "1"].includes(String(fd.get("autoRefresh") ?? "").toLowerCase()),
    reports,
  };
}
