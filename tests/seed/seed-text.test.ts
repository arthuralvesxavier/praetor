import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "@/domain/demo";
import { CLAIM_CATEGORIES, LOSS_PROBABILITIES, PROBABILITY_BANDS } from "@/domain/enums";
import { createApiKeySchema } from "@/modules/api-keys/schemas";
import { claimAssessmentSchema, claimSchema } from "@/modules/claims/schemas";
import { closeJustificationSchema } from "@/modules/contingency/close-gate";
import { addScenarioSchema } from "@/modules/legal-reports/schemas";
import * as aurora from "../../scripts/seed-data/aurora";
import * as outra from "../../scripts/seed-data/outra";
import * as v2 from "../../scripts/seed-data/v2/aurora-v2";

/**
 * Text written by the seeds ends up on screen (titles, names, descriptions,
 * opinions, account descriptions on the login page): no em/en dash and no
 * internal rule codes. Names used only to find rows written by earlier
 * versions of the seed (`legacyNames`) are never written.
 */
function strings(value: unknown, path: string, out: { path: string; text: string }[] = []) {
  if (typeof value === "string") out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (k !== "legacyNames") strings(v, `${path}.${k}`, out);
  }
  return out;
}

const SEED_TEXT = [
  ...strings(aurora, "aurora"),
  ...strings(outra, "outra"),
  ...strings(v2, "v2"),
  ...strings(DEMO_ACCOUNTS, "DEMO_ACCOUNTS"),
  ...strings(v2.hearingLocation("Palmas", "1ª Vara do Trabalho"), "hearingLocation"),
];

describe("seed text shown on screen", () => {
  it("has no em dash or en dash", () => {
    const bad = SEED_TEXT.filter((s) => /[–—]/.test(s.text)).map((s) => s.path);
    expect(bad).toEqual([]);
  });

  it("has no internal rule codes (RN-, RF-, RNF-, TE-)", () => {
    const bad = SEED_TEXT.filter((s) => /\b(RN|RF|RNF|TE)-\d/.test(s.text)).map((s) => `${s.path}: ${s.text}`);
    expect(bad).toEqual([]);
  });

  it("keeps the earlier rule names only as lookups for rules that already exist", () => {
    for (const r of v2.V2_RULES) {
      for (const legacy of r.legacyNames ?? []) {
        expect(legacy).not.toBe(r.name);
        expect(legacy.replace(/ — /, ": ")).toBe(r.name);
      }
    }
  });
});

describe("v2 demo data added after P1", () => {
  it("closes with a justification the close gate accepts", () => {
    expect(closeJustificationSchema.safeParse({ justification: v2.CLOSE_JUSTIFICATION }).success).toBe(true);
    expect(v2.CLOSE_JUSTIFICATION).toBe("Fechamento de demonstração: processos importados ainda sem classificação de risco.");
  });

  it("creates claims and assessments the claims module accepts, labeled as fictitious", () => {
    for (const t of v2.CLAIM_TEMPLATES) {
      const quantified = t.items.filter((i) => i.share !== null).reduce((sum, i) => sum + (i.share ?? 0), 0);
      expect(quantified).toBeGreaterThan(0);
      expect(quantified).toBeLessThanOrEqual(1.0001);
      for (const item of t.items) {
        expect(CLAIM_CATEGORIES).toContain(item.category);
        const description = v2.claimDescription(item);
        expect(description.endsWith(v2.CLAIM_FICTITIOUS_SUFFIX)).toBe(true);
        const parsed = claimSchema.safeParse({
          description,
          category: item.category,
          claimedAmountCents: item.share === null ? null : 1_000_00,
          amountBaseDate: item.share === null ? null : "2026-07-29",
          correctionIndex: null,
          instance: "first",
        });
        expect(parsed.success).toBe(true);
      }
    }
    for (const cls of LOSS_PROBABILITIES) {
      expect(v2.CLAIM_OPINIONS[cls].length).toBeGreaterThan(0);
      for (const opinion of v2.CLAIM_OPINIONS[cls]) {
        expect(opinion).toContain("(parecer fictício)");
        expect(claimAssessmentSchema.safeParse({ classification: cls, percentage: null, opinion, effectiveFrom: "2026-10-01" }).success).toBe(true);
      }
    }
  });

  it("proposes scenarios inside valid bands, labeled as demonstration", () => {
    for (const cls of LOSS_PROBABILITIES) {
      for (const p of v2.SCENARIO_PROPOSALS[cls]) {
        expect(PROBABILITY_BANDS).toContain(p.band);
        expect(p.description).toContain("(cenário de demonstração)");
        expect(addScenarioSchema.safeParse({ description: p.description, probabilityBand: p.band, comment: v2.SCENARIO_COMMENT }).success).toBe(true);
      }
    }
    expect(v2.SCENARIO_COMMENT).toContain("(dados fictícios)");
  });

  it("names the demo API key as agreed and asks only for the inbound scopes", () => {
    expect(v2.DEMO_API_KEY.name).toBe("Chave de demonstração, use só neste computador");
    expect(createApiKeySchema.safeParse({ name: v2.DEMO_API_KEY.name, scopes: v2.DEMO_API_KEY.scopes, expiresOn: null }).success).toBe(true);
    expect([...v2.DEMO_API_KEY.scopes].sort()).toEqual(["intake:create", "process:read"]);
  });
});
