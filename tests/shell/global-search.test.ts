import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SEARCH_MAX_LENGTH, countSearchHits, normalizeSearchQuery, runGlobalSearch } from "@/app/(app)/busca/search";
import { cnjDigits, computeCnjCheckDigit } from "@/domain/cnj";
import {
  makeContract,
  makeOccurrence,
  makeProcess,
  makeTextDocument,
  setupFixture,
  type Fixture,
} from "../helpers/fixtures";

let seq = 7300;
function cnj(): string {
  seq += 1;
  const parts = { sequence: String(seq).padStart(7, "0"), year: 2025, segment: "5", tribunal: "10", origin: "0021" };
  return `${parts.sequence}-${computeCnjCheckDigit(parts)}.${parts.year}.${parts.segment}.${parts.tribunal}.${parts.origin}`;
}

describe("normalizeSearchQuery", () => {
  it("trims, collapses whitespace and caps the length", () => {
    expect(normalizeSearchQuery("  ação   trabalhista \n ")).toBe("ação trabalhista");
    expect(normalizeSearchQuery(undefined)).toBe("");
    expect(normalizeSearchQuery("x".repeat(500))).toHaveLength(SEARCH_MAX_LENGTH);
  });
});

describe("runGlobalSearch (/busca)", () => {
  let fx: Fixture;
  const ids: Record<string, string> = {};
  const numbers: Record<string, string> = {};

  beforeAll(async () => {
    fx = await setupFixture("shell-search");
    const { manager } = fx.ctx;
    numbers.sp = cnj();
    numbers.re = cnj();
    numbers.secret = cnj();
    numbers.firm = cnj();
    ids.sp = await makeProcess(manager, {
      number: numbers.sp,
      unitId: fx.unitSp,
      title: "Reclamação Quasar SP",
      court: "TRT10",
    });
    ids.re = await makeProcess(manager, {
      number: numbers.re,
      unitId: fx.unitRe,
      title: "Reclamação Quasar RE",
      court: "TRT10",
    });
    ids.secret = await makeProcess(manager, {
      number: numbers.secret,
      unitId: fx.unitSp,
      isConfidential: true,
      title: "Reclamação Quasar sigilosa",
      court: "TRT10",
    });
    ids.firm = await makeProcess(manager, {
      number: numbers.firm,
      lawFirmId: fx.lawFirmA,
      unitId: fx.unitRe,
      title: "Reclamação Quasar do escritório",
      court: "TRT10",
    });
    const doc = await makeTextDocument(manager, {
      text: "Conteúdo fictício que não é pesquisado pela busca global.",
      title: "Petição inicial Quasar",
      category: "other",
      processId: ids.sp,
    });
    ids.doc = doc.documentId;
    ids.contract = await makeContract(manager, { title: "Contrato Quasar de limpeza", unitId: fx.unitSp });
    ids.occurrence = await makeOccurrence(manager, { title: "Ocorrência Quasar no armazém", unitId: fx.unitSp });

    // Organization B has a homonymous record that must never leak into A (and vice versa).
    await makeProcess(fx.ctx.adminB, { number: cnj(), title: "Reclamação Quasar da organização B", court: "TRT10" });
  });

  afterAll(async () => {
    await fx?.teardown();
  });

  it("asks for at least 2 characters without querying", async () => {
    const r = await runGlobalSearch(fx.ctx.admin, " q ");
    expect(r.tooShort).toBe(true);
    expect(r.processes?.items).toEqual([]);
    expect(countSearchHits(r)).toBe(0);
  });

  it("finds processes, documents, contracts and occurrences the admin can see", async () => {
    const r = await runGlobalSearch(fx.ctx.admin, "quasar");
    expect(r.tooShort).toBe(false);
    expect(r.processes?.items.map((p) => p.id).sort()).toEqual([ids.sp, ids.re, ids.secret, ids.firm].sort());
    expect(r.processes?.items.every((p) => p.court === "TRT10" && p.status === "active")).toBe(true);
    expect(r.documents?.items.map((d) => d.id)).toEqual([ids.doc]);
    expect(r.documents?.items[0].linkedTo.join(" ")).toContain("Reclamação Quasar SP");
    expect(r.contracts?.items.map((c) => c.id)).toEqual([ids.contract]);
    expect(r.occurrences?.items.map((o) => o.id)).toEqual([ids.occurrence]);
    expect(countSearchHits(r)).toBe(7);
  });

  it("finds a process by its CNJ typed without punctuation", async () => {
    const r = await runGlobalSearch(fx.ctx.admin, cnjDigits(numbers.re));
    expect(r.processes?.items.map((p) => p.id)).toEqual([ids.re]);
    expect(r.processes?.items[0].number).toBe(numbers.re);
  });

  it("applies the row visibility of each user", async () => {
    const lawyer = await runGlobalSearch(fx.ctx.lawyer, "quasar");
    expect(lawyer.processes?.items.map((p) => p.id)).toEqual([ids.sp]);

    const lawyerRe = await runGlobalSearch(fx.ctx.lawyerRe, "quasar");
    expect(lawyerRe.processes?.items.map((p) => p.id).sort()).toEqual([ids.re, ids.firm].sort());
    expect(lawyerRe.documents?.total).toBe(0);
    expect(lawyerRe.contracts?.total).toBe(0);

    const executive = await runGlobalSearch(fx.ctx.executive, "quasar");
    expect(executive.processes?.items.map((p) => p.id)).not.toContain(ids.secret);
    expect(executive.processes?.items).toHaveLength(3);
  });

  it("limits the external counsel to the processes of their law firm and hides sections without permission", async () => {
    const r = await runGlobalSearch(fx.ctx.externalCounsel, "quasar");
    expect(r.processes?.items.map((p) => p.id)).toEqual([ids.firm]);
    expect(r.contracts).toBeNull();
    expect(r.occurrences).toBeNull();
    expect(r.documents).not.toBeNull();
    expect(r.documents?.total).toBe(0);
  });

  it("skips sections the role cannot read (accountant)", async () => {
    const r = await runGlobalSearch(fx.ctx.accountant, "quasar");
    expect(r.processes).not.toBeNull();
    expect(r.documents).not.toBeNull();
    expect(r.contracts).toBeNull();
    expect(r.occurrences).toBeNull();
  });

  it("isolates organizations", async () => {
    const b = await runGlobalSearch(fx.ctx.adminB, "quasar");
    expect(b.processes?.items.map((p) => p.title)).toEqual(["Reclamação Quasar da organização B"]);
    expect(b.documents?.total).toBe(0);
    expect(b.contracts?.total).toBe(0);
    expect(b.occurrences?.total).toBe(0);

    const a = await runGlobalSearch(fx.ctx.admin, "organização B");
    expect(a.processes?.items).toEqual([]);
  });
});
