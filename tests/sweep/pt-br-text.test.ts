import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Product-owner copy rules for every pt-BR text the user can see (screens, toasts,
 * errors, e-mails, PDF, CSV/XLSX headers): no em dash and no en dash used as
 * punctuation, no internal requirement codes (RN-xx, RF-xx, TE-xx, PD-xx, INT-xx)
 * and the old "marcado para verificação" wording replaced by "pendente de
 * conferência".
 *
 * Two checks:
 * 1. Runtime: every string exported by the label/constant modules (enums *_LABELS,
 *    module labels, banners, notices) is walked recursively.
 * 2. Source: every .ts/.tsx under src/ is read with comments removed, so string
 *    literals and JSX text in src/app, src/modules and src/components are covered.
 *    Regex character classes that match dashes in imported data (spreadsheet
 *    cells, court names) are not text and are ignored.
 *
 * Kept on purpose: the fictitious demonstration documents (demo-documents.ts)
 * imitate court papers and keep their typography, like any literal excerpt of a
 * source document; the banner and the titles the system registers are checked.
 */

vi.mock("server-only", () => ({}));

const ROOT = path.resolve(import.meta.dirname, "../..");
const SRC = path.join(ROOT, "src");

const DASH = /[—–]/;
const INTERNAL_CODE = /\b(?:RNF|RN|RF|TE|PD|INT)-\d+/;
const OLD_VERIFICATION = /marcad[oa]s? para verifica/i;

/** Source files whose remaining dashes are fictitious document content (see above). */
const SOURCE_DOCUMENT_FILES = new Set(["src/modules/briefs/demo-documents.ts"]);

type Found = { where: string; text: string };

function collectStrings(value: unknown, where: string, out: Found[], seen = new Set<unknown>()): Found[] {
  if (typeof value === "string") {
    out.push({ where, text: value });
    return out;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectStrings(v, `${where}[${i}]`, out, seen));
    return out;
  }
  // Plain objects only: zod schemas, Dates, Maps and class instances are not copy.
  if (Object.getPrototypeOf(value) !== Object.prototype) return out;
  for (const [k, v] of Object.entries(value)) collectStrings(v, `${where}.${k}`, out, seen);
  return out;
}

const LABEL_MODULES: Record<string, () => Promise<Record<string, unknown>>> = {
  "@/domain/enums": () => import("@/domain/enums"),
  "@/domain/analysis": () => import("@/domain/analysis"),
  "@/domain/case-brief": () => import("@/domain/case-brief"),
  "@/domain/legal-reports": () => import("@/domain/legal-reports"),
  "@/domain/demo": () => import("@/domain/demo"),
  "@/modules/api-keys/labels": () => import("@/modules/api-keys/labels"),
  "@/modules/bi/labels": () => import("@/modules/bi/labels"),
  "@/modules/claims/labels": () => import("@/modules/claims/labels"),
  "@/modules/contingency/labels": () => import("@/modules/contingency/labels"),
  "@/modules/court-sync/labels": () => import("@/modules/court-sync/labels"),
  "@/modules/emails/labels": () => import("@/modules/emails/labels"),
  "@/modules/imports/labels": () => import("@/modules/imports/labels"),
  "@/modules/legal-reports/labels": () => import("@/modules/legal-reports/labels"),
  "@/modules/admin/history-format": () => import("@/modules/admin/history-format"),
  "@/modules/alerts/areas": () => import("@/modules/alerts/areas"),
  "@/modules/intake/status": () => import("@/modules/intake/status"),
  "@/modules/intake/simulation": () => import("@/modules/intake/simulation"),
  "@/modules/reports/types": () => import("@/modules/reports/types"),
  "@/modules/preventive-intel/suggestions": () => import("@/modules/preventive-intel/suggestions"),
  "@/modules/emails/render": () => import("@/modules/emails/render"),
  "@/server/auth/permissions": () => import("@/server/auth/permissions"),
};

async function exportedStrings(): Promise<Found[]> {
  const out: Found[] = [];
  for (const [name, load] of Object.entries(LABEL_MODULES)) {
    const mod = await load();
    for (const [key, value] of Object.entries(mod)) collectStrings(value, `${name}:${key}`, out);
  }
  const { DEMO_DOCUMENT_BANNER } = await import("@/modules/briefs/demo-documents");
  out.push({ where: "demo-documents:DEMO_DOCUMENT_BANNER", text: DEMO_DOCUMENT_BANNER });
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Source text without comments; line numbers are preserved. */
function stripComments(source: string): string {
  const keepLines = (m: string) => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, (_m, lead: string) => lead);
}

/** Regex character classes such as `[-–—/,]` match imported data, they are not copy. */
function withoutDashCharClasses(line: string): string {
  return line.replace(/\[[^\]\n]*[—–][^\]\n]*\]/g, "[]");
}

function sourceFindings(test: (line: string) => boolean): Found[] {
  const out: Found[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (SOURCE_DOCUMENT_FILES.has(rel)) continue;
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (test(withoutDashCharClasses(line))) out.push({ where: `${rel}:${i + 1}`, text: line.trim() });
    });
  }
  return out;
}

const format = (items: Found[]) => items.map((f) => `${f.where}: ${f.text.slice(0, 160)}`);

describe("pt-BR copy: exported labels and constants", () => {
  it("has no em dash or en dash", async () => {
    const strings = await exportedStrings();
    expect(strings.length).toBeGreaterThan(500);
    expect(format(strings.filter((s) => DASH.test(s.text)))).toEqual([]);
  });

  it("has no internal requirement codes", async () => {
    expect(format((await exportedStrings()).filter((s) => INTERNAL_CODE.test(s.text)))).toEqual([]);
  });

  it('uses "pendente de conferência" instead of "marcado para verificação"', async () => {
    expect(format((await exportedStrings()).filter((s) => OLD_VERIFICATION.test(s.text)))).toEqual([]);
  });
});

describe("pt-BR copy: string literals and JSX text in src/", () => {
  it("has no em dash or en dash outside comments", () => {
    expect(format(sourceFindings((line) => DASH.test(line)))).toEqual([]);
  });

  it("has no internal requirement codes outside comments", () => {
    expect(format(sourceFindings((line) => INTERNAL_CODE.test(line)))).toEqual([]);
  });

  it('has no "marcado para verificação" outside comments', () => {
    expect(format(sourceFindings((line) => OLD_VERIFICATION.test(line)))).toEqual([]);
  });

  it("keeps dashes only in the body of the fictitious documents, never in their registered titles", () => {
    const source = readFileSync(path.join(ROOT, "src/modules/briefs/demo-documents.ts"), "utf8");
    const titles = [...source.matchAll(/await add\(\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(titles.length).toBeGreaterThan(3);
    expect(titles.filter((t) => DASH.test(t))).toEqual([]);
    expect(source).toMatch(/setAuthor\("Praetor, dados de demonstração"\)/);
  });

  it("ignores comments and dash character classes only", () => {
    expect(stripComments('const a = "x"; // nota — comentário\n/* bloco — */ const b = 1;')).not.toMatch(DASH);
    expect(stripComments('const url = "https://exemplo.com/a — b";')).toMatch(DASH);
    expect(withoutDashCharClasses("const re = /^[-–—]+$/;")).not.toMatch(DASH);
    expect(withoutDashCharClasses('const s = "Fase — conferir";')).toMatch(DASH);
  });
});
