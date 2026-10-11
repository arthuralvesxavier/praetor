import { z } from "zod";
import { OCCURRENCE_CATEGORIES, OCCURRENCE_STATUSES, RISK_LEVELS } from "@/domain/enums";
import { todayISO } from "@/lib/format";

/** zod input contracts for the preventive (occurrences) module. Client-safe: no server imports. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const isoDate = (message: string) => z.string().refine(isValidIsoDate, { error: message });

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `${label} deve ter no máximo ${max.toLocaleString("pt-BR")} caracteres.` })
    .nullish()
    .transform((v) => (v ? v : null));

/** Upper bound for estimated exposure: R$ 100 bilhões (in cents). */
export const MAX_EXPOSURE_CENTS = 10_000_000_000_000;

export const MAX_AREAS = 30;
export const MAX_MISSING_ITEMS = 50;

/** Fields shared by create and update, without defaults (update uses `.partial()`). */
const occurrenceFields = {
  title: z
    .string({ error: "Informe o título." })
    .trim()
    .min(3, { error: "O título deve ter pelo menos 3 caracteres." })
    .max(200, { error: "O título deve ter no máximo 200 caracteres." }),
  facts: z
    .string({ error: "Descreva os fatos." })
    .trim()
    .min(10, { error: "Descreva os fatos com pelo menos 10 caracteres." })
    .max(20_000, { error: "A descrição dos fatos deve ter no máximo 20.000 caracteres." }),
  category: z.enum(OCCURRENCE_CATEGORIES, { error: "Selecione a categoria." }),
  status: z.enum(OCCURRENCE_STATUSES, { error: "Selecione a situação." }),
  riskLevel: z.enum(RISK_LEVELS, { error: "Selecione o nível de risco." }),
  riskRationale: optionalText(4000, "A justificativa do risco"),
  areasInvolved: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(80, { error: "Cada área deve ter no máximo 80 caracteres." }),
    )
    .max(MAX_AREAS, { error: `Informe no máximo ${MAX_AREAS} áreas.` })
    .transform((list) => dedupe(list)),
  involvedParties: optionalText(4000, "O campo de partes envolvidas"),
  missingInformation: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(500, { error: "Cada informação faltante deve ter no máximo 500 caracteres." }),
    )
    .max(MAX_MISSING_ITEMS, { error: `Informe no máximo ${MAX_MISSING_ITEMS} itens.` })
    .transform((list) => dedupe(list)),
  estimatedExposureCents: z
    .number({ error: "Informe um valor válido, por exemplo 15.000,00." })
    .int({ error: "Informe um valor válido, por exemplo 15.000,00." })
    .min(0, { error: "A exposição estimada não pode ser negativa." })
    .max(MAX_EXPOSURE_CENTS, { error: "Valor acima do limite permitido." })
    .nullish()
    .transform((v) => v ?? null),
  unitId: z
    .uuid({ error: "Unidade inválida." })
    .nullish()
    .transform((v) => v ?? null),
  responsibleId: z
    .uuid({ error: "Responsável inválido." })
    .nullish()
    .transform((v) => v ?? null),
  reportedById: z
    .uuid({ error: "Pessoa que reportou inválida." })
    .nullish()
    .transform((v) => v ?? null),
  occurredOn: isoDate("Data da ocorrência inválida.")
    .nullish()
    .transform((v) => v ?? null),
  reportedOn: isoDate("Data do reporte inválida."),
  isConfidential: z.boolean(),
};

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.toLocaleLowerCase("pt-BR");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Date coherence rules shared by create and update (the service re-checks the
 * merged values on update): no future dates; the facts cannot happen after
 * they were reported.
 */
export function dateIssues(
  occurredOn: string | null | undefined,
  reportedOn: string | null | undefined,
  today: string = todayISO(),
): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  if (occurredOn && occurredOn > today) {
    issues.push({ path: ["occurredOn"], message: "A data da ocorrência não pode estar no futuro." });
  } else if (occurredOn && reportedOn && occurredOn > reportedOn) {
    issues.push({ path: ["occurredOn"], message: "A data da ocorrência não pode ser posterior à data do reporte." });
  }
  if (reportedOn && reportedOn > today) {
    issues.push({ path: ["reportedOn"], message: "A data do reporte não pode estar no futuro." });
  }
  return issues;
}

/** Create input. Missing optional fields get defaults (`reportedOn` defaults to today). */
export const createOccurrenceSchema = z
  .object({
    ...occurrenceFields,
    status: occurrenceFields.status.default("open"),
    riskLevel: occurrenceFields.riskLevel.default("medium"),
    areasInvolved: occurrenceFields.areasInvolved.default([]),
    missingInformation: occurrenceFields.missingInformation.default([]),
    reportedOn: occurrenceFields.reportedOn.default(() => todayISO()),
    isConfidential: occurrenceFields.isConfidential.default(false),
  })
  .superRefine((v, ctx) => {
    for (const issue of dateIssues(v.occurredOn, v.reportedOn)) ctx.addIssue({ code: "custom", ...issue });
  });
export type CreateOccurrenceInput = z.input<typeof createOccurrenceSchema>;

/** Update input: every field optional; omitted fields keep their current value. */
export const updateOccurrenceSchema = z.object(occurrenceFields).partial();
export type UpdateOccurrenceInput = z.input<typeof updateOccurrenceSchema>;

export const occurrenceFiltersSchema = z.object({
  q: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : undefined)),
  status: z.enum(OCCURRENCE_STATUSES).optional(),
  category: z.enum(OCCURRENCE_CATEGORIES).optional(),
  /** A single level or several (e.g. high + critical from the KPI deep link). */
  riskLevel: z.union([z.enum(RISK_LEVELS), z.array(z.enum(RISK_LEVELS)).max(RISK_LEVELS.length)]).optional(),
  unitId: z.uuid().optional(),
  responsibleId: z.uuid().optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
});

export const idSchema = z.uuid({ error: "Registro inválido." });

/** Splits "RH, Comercial; Jurídico" into trimmed, non-empty items (form helper, client-safe). */
export function splitList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
