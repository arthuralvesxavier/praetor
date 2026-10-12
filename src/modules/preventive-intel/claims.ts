/**
 * Categorization of claims ("pedidos") read from preliminary case analyses
 * (pure, client-safe). Only claims with provenance `extracted` are aggregated.
 * Claims about sensitive personal data — health (doença, acidente, laudo,
 * atestado, CAT, estabilidade acidentária...) or union membership — are
 * counted as excluded and never shown (PD-06). The free text of a claim is
 * never exposed: only the category label and counts.
 */
import type { BriefClaim } from "@/domain/case-brief";
import type { ClaimCategoryStat, RecurringClaims } from "./types";

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const SENSITIVE =
  /\b(doenca|doencas|acidente|acidentaria|acidentario|saude|cat\b|atestado|laudo|pericia medica|lesao|ler\b|dort|depress|burnout|psiqui|gestante|gravidez|gestacional|hiv|deficien|cid\b|sindic|filiacao|contribuicao (assistencial|confederativa|sindical)|religi|orientacao sexual|racial)/;

export const CLAIM_CATEGORIES: readonly { key: string; label: string; pattern: RegExp }[] = [
  { key: "horas_extras", label: "Horas extras / sobrejornada", pattern: /(horas? extras?|sobrejornada|jornada extraordinaria|banco de horas)/ },
  { key: "intervalos", label: "Intervalos intrajornada / interjornada", pattern: /(intervalo|intrajornada|interjornada)/ },
  { key: "verbas_rescisorias", label: "Verbas rescisórias e multas (arts. 467/477)", pattern: /(rescis|aviso previo|\b477\b|\b467\b|trct|saldo de salario)/ },
  { key: "fgts", label: "FGTS e multa de 40%", pattern: /(fgts|fundo de garantia)/ },
  { key: "dano_moral", label: "Indenização por dano moral", pattern: /(dano(s)? mora|danos? extrapatrimonia|indenizacao por dano|assedio moral)/ },
  { key: "adicional_noturno", label: "Adicional noturno", pattern: /(adicional noturno|hora noturna|horas noturnas)/ },
  { key: "insalubridade_periculosidade", label: "Adicional de insalubridade / periculosidade", pattern: /(insalubridade|periculosidade)/ },
  { key: "equiparacao_funcao", label: "Equiparação salarial / desvio ou acúmulo de função", pattern: /(equiparacao|desvio de funcao|acumulo de funcao|acumulo de funcoes)/ },
  { key: "vinculo", label: "Reconhecimento de vínculo / anotação da CTPS", pattern: /(vinculo|anotacao (da|na|em) ctps|carteira de trabalho|registro em ctps)/ },
  { key: "ferias_13", label: "Férias e 13º salário", pattern: /(ferias|13o|13º|decimo terceiro|gratificacao natalina)/ },
  { key: "diferencas_salariais", label: "Diferenças salariais / piso", pattern: /(diferencas? salaria|piso salarial|reajuste salarial|salario por fora|salario extrafolha)/ },
  { key: "honorarios", label: "Honorários advocatícios", pattern: /(honorario)/ },
];

export type ClaimClassification = { kind: "sensitive" } | { kind: "category"; key: string } | { kind: "uncategorized" };

export function classifyClaim(description: string): ClaimClassification {
  const text = normalize(description);
  if (SENSITIVE.test(text)) return { kind: "sensitive" };
  const cat = CLAIM_CATEGORIES.find((c) => c.pattern.test(text));
  return cat ? { kind: "category", key: cat.key } : { kind: "uncategorized" };
}

/**
 * Aggregates the claims of the latest brief of each process. `briefs` must
 * already be restricted to briefs visible to the viewer.
 */
export function aggregateClaims(briefs: { processId: string; claims: BriefClaim[] | null | undefined }[]): RecurringClaims {
  const processesByCategory = new Map<string, Set<string>>();
  const amounts = new Map<string, { n: number; cents: number }>();
  let claimsConsidered = 0;
  let uncategorized = 0;
  let excludedSensitive = 0;
  let ignoredNotExtracted = 0;

  for (const b of briefs) {
    for (const claim of Array.isArray(b.claims) ? b.claims : []) {
      if (!claim || typeof claim.description !== "string") continue;
      if (claim.provenance !== "extracted") {
        ignoredNotExtracted += 1;
        continue;
      }
      const c = classifyClaim(claim.description);
      if (c.kind === "sensitive") {
        excludedSensitive += 1;
        continue;
      }
      claimsConsidered += 1;
      if (c.kind === "uncategorized") {
        uncategorized += 1;
        continue;
      }
      const set = processesByCategory.get(c.key) ?? new Set<string>();
      set.add(b.processId);
      processesByCategory.set(c.key, set);
      if (typeof claim.amountCents === "number" && Number.isFinite(claim.amountCents)) {
        const a = amounts.get(c.key) ?? { n: 0, cents: 0 };
        amounts.set(c.key, { n: a.n + 1, cents: a.cents + Math.round(claim.amountCents) });
      }
    }
  }

  const total = new Set(briefs.map((b) => b.processId)).size;
  const rows: ClaimCategoryStat[] = CLAIM_CATEGORIES.filter((c) => processesByCategory.has(c.key))
    .map((c) => {
      const n = processesByCategory.get(c.key)!.size;
      const a = amounts.get(c.key);
      return {
        key: c.key,
        label: c.label,
        processCount: n,
        share: total > 0 ? n / total : 0,
        withAmount: a?.n ?? 0,
        amountCents: a?.cents ?? 0,
      };
    })
    .sort((x, y) => y.processCount - x.processCount || x.label.localeCompare(y.label, "pt-BR"));

  return { briefsConsidered: briefs.length, claimsConsidered, rows, uncategorized, excludedSensitive, ignoredNotExtracted };
}
