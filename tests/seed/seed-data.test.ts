import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "@/domain/demo";
import { isCnjNumberFormat } from "@/modules/processes/schemas";
import {
  AURORA_CONTRACTS,
  AURORA_DOCUMENTS,
  AURORA_OCCURRENCES,
  AURORA_PROCESSES,
  AURORA_USERS,
} from "../../scripts/seed-data/aurora";
import { brDate, longDate, renderDocument } from "../../scripts/seed-data/helpers";
import { OUTRA_ADMIN_EMAIL, OUTRA_DOCUMENT, OUTRA_PROCESSES } from "../../scripts/seed-data/outra";

const DOCS_DIR = path.resolve(process.cwd(), "scripts", "seed-data", "documents");

describe("demo seed data", () => {
  it("uses only clearly fictional CNJ-shaped process numbers", () => {
    const all = [...AURORA_PROCESSES, ...OUTRA_PROCESSES];
    const numbers = all.map((p) => p.number);
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const n of numbers) {
      expect(isCnjNumberFormat(n)).toBe(true);
      // "00" check digits and "0000" origin: cannot be a real lawsuit number.
      expect(n).toMatch(/^\d{7}-00\.\d{4}\.\d\.\d{2}\.0000$/);
    }
    for (const p of all) expect(p.description.endsWith("(dados fictícios)")).toBe(true);
  });

  it("labels occurrences and contracts as fictional", () => {
    for (const o of AURORA_OCCURRENCES) expect(o.facts).toContain("(dados fictícios)");
    for (const c of AURORA_CONTRACTS) expect(c.description).toContain("(dados fictícios)");
  });

  it("maps every demo account to exactly one organization", () => {
    const emails = DEMO_ACCOUNTS.map((a) => a.email);
    for (const e of Object.keys(AURORA_USERS)) expect(emails).toContain(e);
    expect(emails).toContain(OUTRA_ADMIN_EMAIL);
    expect(Object.keys(AURORA_USERS)).not.toContain(OUTRA_ADMIN_EMAIL);
    expect(Object.keys(AURORA_USERS).length + 1).toBe(DEMO_ACCOUNTS.length);
  });

  it("has exactly one confidential process and it belongs to the São Paulo lawyer", () => {
    const confidential = AURORA_PROCESSES.filter((p) => p.isConfidential);
    expect(confidential).toHaveLength(1);
    expect(confidential[0].responsible).toBe("advogada");
    expect(AURORA_PROCESSES.filter((p) => p.imported)).toHaveLength(2);
  });

  it("renders every document template without leftover placeholders", () => {
    const referenced = new Set([
      ...AURORA_DOCUMENTS.map((d) => d.file),
      "contrato-logistica-v2.txt",
      OUTRA_DOCUMENT.file,
    ]);
    const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".txt"));
    for (const f of referenced) expect(files).toContain(f);
    for (const f of files) {
      const text = renderDocument(f);
      expect(text).not.toMatch(/\{\{/);
      expect(text.toLowerCase()).toContain("fictíci");
    }
  });

  it("keeps the prompt-injection sample in the supplier e-mail", () => {
    expect(renderDocument("email-fornecedor-atraso.txt")).toContain("IGNORE AS INSTRUÇÕES ANTERIORES");
  });

  it("formats dates in pt-BR", () => {
    expect(brDate("2026-03-05")).toBe("05/03/2026");
    expect(longDate("2026-03-05")).toBe("5 de março de 2026");
  });
});
