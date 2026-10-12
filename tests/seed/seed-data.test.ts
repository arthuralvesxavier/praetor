import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "@/domain/demo";
import { PROCESS_INSTANCES, PROCESS_PHASES } from "@/domain/enums";
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
import { AURORA_V2_USERS } from "../../scripts/seed-data/v2/aurora-v2";

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

  it("maps every demo account to exactly one organization and seed script", () => {
    const emails = DEMO_ACCOUNTS.map((a) => a.email);
    expect(new Set(emails).size).toBe(emails.length);
    const v1 = Object.keys(AURORA_USERS);
    const v2 = Object.keys(AURORA_V2_USERS);
    for (const e of [...v1, ...v2]) expect(emails).toContain(e);
    expect(emails).toContain(OUTRA_ADMIN_EMAIL);
    expect(v1).not.toContain(OUTRA_ADMIN_EMAIL);
    expect(v2.filter((e) => v1.includes(e) || e === OUTRA_ADMIN_EMAIL)).toEqual([]);
    expect(v1.length + v2.length + 1).toBe(DEMO_ACCOUNTS.length);
  });

  it("has exactly one confidential process and it belongs to the São Paulo lawyer", () => {
    const confidential = AURORA_PROCESSES.filter((p) => p.isConfidential);
    expect(confidential).toHaveLength(1);
    expect(confidential[0].responsible).toBe("advogada");
    expect(AURORA_PROCESSES.filter((p) => p.imported)).toHaveLength(2);
  });

  it("gives every process out of the active portfolio a closure reason (RN-12) and an opinion for its risk", () => {
    for (const p of [...AURORA_PROCESSES, ...OUTRA_PROCESSES]) {
      if (p.status === "closed" || p.status === "archived") expect(p.closureReason).toBeTruthy();
      // The risk rationale becomes the opinion of the official classification (min. 10 characters).
      if (p.lossProbability) expect(p.riskRationale.trim().length).toBeGreaterThanOrEqual(10);
    }
  });

  it("uses only the three phases and records 'em recurso' as the instance, never as a phase (P0.5)", () => {
    const all = [...AURORA_PROCESSES, ...OUTRA_PROCESSES];
    for (const p of all) {
      // The CHECK constraints refuse any other value, so `npm run db:seed` would fail at runtime.
      expect(PROCESS_PHASES).toContain(p.phase);
      if (p.instance !== undefined) expect(PROCESS_INSTANCES).toContain(p.instance);
    }
    // Pending appeals (apelação / recurso ordinário): knowledge phase at the 2nd grau.
    for (const key of ["coletivaRecife", "mandadoSeguranca", "terceirizado"] as const) {
      const p = AURORA_PROCESSES.find((x) => x.key === key);
      expect(p?.phase).toBe("knowledge");
      expect(p?.instance).toBe("second");
    }
    // A closed process is closed by its status (with a closure reason), never by its phase.
    const closed = AURORA_PROCESSES.find((x) => x.key === "acordoEncerrado");
    expect(closed?.status).toBe("closed");
    expect(closed?.closureReason).toBe("settlement_fulfilled");
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
