import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AlertType } from "@/domain/enums";
import { alertHref } from "@/modules/alerts/service";
import { buildDemoCaseDocuments, type DemoCaseInfo } from "@/modules/briefs/demo-documents";
import { PROCESS_TAB_KEYS, resolveProcessTab } from "@/modules/processes/tabs";
import type { CaseBriefDocumentSource, CaseBriefRecord } from "@/server/integrations/ai/case-brief/provider";
import { buildSimulatedCaseBrief } from "@/server/integrations/ai/case-brief/simulated";
import { extractText } from "@/server/integrations/text-extraction";
import { demoInfo } from "../../briefs/helpers";

/**
 * P0.6 final check, group "textos":
 * 1. the fictitious demonstration PDFs carry no em dash / en dash, and the simulated
 *    extractor still reads claims, amounts, parties and dates from them;
 * 2. the claim list accepts ": R$" (new demo layout) besides the dashes of other documents;
 * 3. process links of this group's files use the six-tab keys (no legacy key).
 */

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DASH = /[\u2013\u2014]/;
const TODAY = "2026-10-11";

function recordFor(info: DemoCaseInfo, overrides: Partial<CaseBriefRecord> = {}): CaseBriefRecord {
  return {
    number: info.number,
    title: `${info.plaintiff} x ${info.defendant}`,
    court: info.court,
    courtDivision: info.courtDivision,
    city: info.city,
    state: info.state,
    area: "labor",
    phase: "knowledge",
    phaseDetail: null,
    instance: "first",
    processClass: info.processClass,
    claimAmountCents: info.claimAmountCents,
    liquidatedAmountCents: null,
    filedAt: info.filedAt,
    companyName: "Empresa Fictícia A Ltda.",
    responsibleName: "Laura Advogada",
    parties: [],
    instances: [],
    events: [],
    recordSourceLabel: "Planilha de dados fictícios",
    ...overrides,
  };
}

type Pack = { info: DemoCaseInfo; sources: CaseBriefDocumentSource[] };
const packs: Record<number, Pack> = {};

beforeAll(async () => {
  for (const variant of [0, 1, 2, 3]) {
    const info = demoInfo({ claimAmountCents: 9_000_000 });
    const docs = await buildDemoCaseDocuments(info, { variant });
    const sources: CaseBriefDocumentSource[] = [];
    for (const [i, d] of docs.entries()) {
      const r = await extractText(d.bytes, d.mimeType);
      expect(r.status).toBe("succeeded");
      sources.push({
        ref: `D${i + 1}`,
        documentId: `00000000-0000-4000-8000-00000000000${i}`,
        versionId: `00000000-0000-4000-8000-00000000001${i}`,
        title: d.title,
        category: d.category,
        fileName: d.fileName,
        text: r.text!,
        pageOffsets: r.pageOffsets ?? null,
        pageCount: r.pageCount ?? null,
      });
    }
    packs[variant] = { info, sources };
  }
}, 120_000);

const byTitle = (p: Pack, title: string) => p.sources.find((s) => s.title === title)!.text;

describe("fictitious demonstration documents", () => {
  it("have no em dash or en dash in any document of any variant", () => {
    for (const { sources } of Object.values(packs)) {
      for (const s of sources) {
        const hits = s.text.split("\n").filter((line) => DASH.test(line));
        expect({ title: s.title, hits }).toEqual({ title: s.title, hits: [] });
      }
    }
  });

  it("has no dash character left in the generator source, outside comments", () => {
    const source = readFileSync(path.join(ROOT, "src/modules/briefs/demo-documents.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1");
    expect(source.split("\n").filter((line) => DASH.test(line))).toEqual([]);
  });

  it("writes claims as 'a) pedido: R$ valor', the signature with commas and the titles on their own lines", () => {
    const { info, sources } = packs[0];
    const petition = byTitle(packs[0], "Petição inicial");
    // Long items wrap in the PDF: read the claims section as one line.
    const claimsSection = petition
      .slice(petition.indexOf("DOS PEDIDOS"), petition.indexOf("VALOR DA CAUSA"))
      .replace(/\s+/g, " ");
    const letters = claimsSection.match(/(?:^| )[a-z]\) /g) ?? [];
    expect(letters).toHaveLength(4);
    expect(claimsSection.match(/: R\$ [\d.]+,\d{2}(?= [a-z]\) |\s*$)/g) ?? []).toHaveLength(4);
    expect(petition.replace(/\s+/g, " ")).toContain(`, advogado(a) do reclamante, OAB/${info.state} nº 00.000 (número fictício)`);

    const lines = (title: string) => byTitle(packs[0], title).split("\n").map((l) => l.trim());
    const ctps = lines("Documentos do reclamante (CTPS e holerites)");
    expect(ctps).toContain("DOCUMENTOS DO RECLAMANTE");
    expect(ctps).toContain("RESUMO DA CTPS");
    const notice = lines("Notificação de audiência inicial");
    expect(notice).toContain(info.court.toUpperCase());
    expect(notice).toContain(info.courtDivision!.toUpperCase());
    expect(notice).toContain("NOTIFICAÇÃO DE AUDIÊNCIA INICIAL");
    const calc = lines("Planilha de cálculos do reclamante");
    expect(calc).toContain("PLANILHA DE CÁLCULOS");
    expect(calc).toContain("ESTIMATIVA APRESENTADA PELO RECLAMANTE");
    expect(sources).toHaveLength(5);
  });

  it("keeps a notice without court division to a single court line", async () => {
    const info = demoInfo({ courtDivision: null });
    const docs = await buildDemoCaseDocuments(info, { variant: 0 });
    const notice = docs.find((d) => d.title === "Notificação de audiência inicial")!;
    const text = (await extractText(notice.bytes, notice.mimeType)).text!;
    const lines = text.split("\n").map((l) => l.trim());
    const at = lines.indexOf("NOTIFICAÇÃO DE AUDIÊNCIA INICIAL");
    expect(lines[at - 1]).toBe(info.court.toUpperCase());
    expect(DASH.test(text)).toBe(false);
  });
});

describe("simulated extractor over the new layout", () => {
  it("reads every claim with its amount, the parties, the dates and the amounts", () => {
    const { info, sources } = packs[0];
    const brief = buildSimulatedCaseBrief({ record: recordFor(info), documents: sources, today: TODAY });
    expect(brief.claims).toHaveLength(4);
    for (const c of brief.claims) {
      expect(c.amountCents).not.toBeNull();
      expect(c.description).not.toMatch(/[:\-]\s*$/);
      expect(c.citations[0]).toMatchObject({ ref: "D1" });
    }
    expect(brief.claims.reduce((a, c) => a + (c.amountCents ?? 0), 0)).toBe(info.claimAmountCents);
    expect(brief.gaps.map((g) => g.text).join("\n")).not.toContain("Pedidos não localizados");

    // Parties read from the documents (the record has none in this check).
    const field = (key: string) => brief.identification.find((f) => f.key === key)!;
    expect(field("plaintiffs")).toMatchObject({ value: info.plaintiff, provenance: "extracted" });
    expect(field("defendants")).toMatchObject({ value: info.defendant, provenance: "extracted" });
    expect(field("employment_admission").provenance).toBe("extracted");
    expect(field("employment_dismissal").provenance).toBe("extracted");

    const hearing = brief.possibleDeadlines.find((d) => d.description.startsWith("Audiência"));
    expect(hearing?.date).toBeTruthy();
    expect(hearing?.citations[0].ref).toBe("D4");

    const amount = (label: string) => brief.amounts.find((a) => a.label === label);
    expect(amount("Valor da causa segundo a petição inicial")?.amountCents).toBe(info.claimAmountCents);
    expect(amount("Total devido segundo a planilha de cálculos")?.amountCents).toBeGreaterThan(0);
    // Valor da causa and valor apurado are never summed.
    expect(brief.amounts.some((a) => /causa.*liquidad|liquidad.*causa/i.test(a.label))).toBe(false);
  });

  it("still detects the deliberate inconsistencies of variant 1", () => {
    const { info, sources } = packs[1];
    const brief = buildSimulatedCaseBrief({ record: recordFor(info), documents: sources, today: TODAY });
    const texts = brief.contradictions.map((c) => c.text).join("\n");
    expect(texts).toMatch(/data de dispensa .* anterior à data de admissão/);
    expect(texts).toMatch(/Valor da causa na petição inicial .* difere do valor cadastrado/);
    expect(texts).toMatch(/Número do processo em “Planilha de cálculos do reclamante”/);
  });

  it("accepts ':' as well as the dashes of other documents before the claim amount", () => {
    const info = demoInfo();
    const em = "\u2014";
    const en = "\u2013";
    const text = [
      "RECLAMAÇÃO TRABALHISTA",
      "DOS PEDIDOS",
      "a) horas extras com reflexos: R$ 1.000,00",
      "b) indenização por danos morais - R$ 2.000,50",
      `c) multa pelo atraso ${em} R$ 300,00;`,
      `d) depósitos do FGTS ${en} R$ 45,10.`,
      "e) honorários sucumbenciais",
    ].join("\n");
    const brief = buildSimulatedCaseBrief({
      record: recordFor(info),
      documents: [
        {
          ref: "D1",
          documentId: "00000000-0000-4000-8000-000000000001",
          versionId: "00000000-0000-4000-8000-000000000002",
          title: "Petição inicial",
          category: "initial_petition",
          fileName: "peticao.txt",
          text,
          pageOffsets: null,
          pageCount: null,
        },
      ],
      today: TODAY,
    });
    expect(brief.claims.map((c) => [c.description, c.amountCents])).toEqual([
      ["horas extras com reflexos", 100_000],
      ["indenização por danos morais", 200_050],
      ["multa pelo atraso", 30_000],
      ["depósitos do FGTS", 4_510],
      ["honorários sucumbenciais", null],
    ]);
  });
});

describe("process links of the group use the six-tab keys", () => {
  const FILES = [
    "src/modules/hearings/components/hearing-row.tsx",
    "src/modules/hearings/components/process-hearings-tab.tsx",
    "src/modules/hearings/routines.ts",
    "src/modules/alerts/service.ts",
    "src/app/(app)/contingencias/garantias/page.tsx",
    "src/app/(app)/contingencias/revisao/page.tsx",
    "src/app/(app)/acordos/page.tsx",
    "src/app/(app)/entrada/[id]/page.tsx",
    "src/app/(app)/analises-preliminares/[id]/page.tsx",
    "src/modules/work/components/work-calendar.tsx",
    "src/modules/contingency/components/process-tabs.tsx",
    "src/modules/legal-reports/service.ts",
  ];

  it("never writes a legacy tab key in a process link", () => {
    const legacy: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      for (const m of source.matchAll(/\/processos\/[^\s"'`]*\?aba=([a-z-]+)/g)) {
        if (!(PROCESS_TAB_KEYS as readonly string[]).includes(m[1])) legacy.push(`${file}: ${m[0]}`);
      }
      // Dynamic tab values (`?aba=${...}`) bypass the typed processTabUrl helper.
      if (/\/processos\/\$\{[^}]+\}\?aba=\$\{/.test(source)) legacy.push(`${file}: dynamic ?aba=`);
    }
    expect(legacy).toEqual([]);
  });

  it("alert links of process alert types open the new tab and section", () => {
    const expected: Partial<Record<AlertType, string>> = {
      valuation_pending_review: "/processos/p1?aba=valores-e-acordos",
      enforcement_without_value: "/processos/p1?aba=valores-e-acordos",
      claims_risk_review: "/processos/p1?aba=valores-e-acordos#classificacao-risco",
      snapshot_close_blocked: "/processos/p1?aba=valores-e-acordos#classificacao-risco",
      court_movement_relevant: "/processos/p1?aba=partes-e-andamento#andamento",
      court_hearing_designated: "/processos/p1?aba=prazos-e-audiencias#audiencias",
    };
    for (const [type, href] of Object.entries(expected)) {
      const got = alertHref("legal_process", "p1", type as AlertType)!;
      expect(got).toBe(href);
      const aba = new URL(got, "http://x").searchParams.get("aba");
      expect(resolveProcessTab(aba).legacy).toBe(false);
    }
    expect(alertHref("legal_process", "p1", "process_needs_verification")).toBe("/processos/p1");
  });

  it("the alerts service comment no longer says the claims panel has no tab", () => {
    const source = readFileSync(path.join(ROOT, "src/modules/alerts/service.ts"), "utf8");
    expect(source).not.toContain("has no tab of its own");
    expect(source).not.toContain("Valores e risco");
  });

  it("the hearings tab no longer says the DataJud is not integrated", () => {
    const source = readFileSync(path.join(ROOT, "src/modules/hearings/components/process-hearings-tab.tsx"), "utf8");
    expect(source).not.toContain("DataJud, PJe, MNI");
    expect(source).toContain("PJe e MNI não estão integrados nesta versão");
    const dialog = readFileSync(path.join(ROOT, "src/modules/hearings/components/hearing-form-dialog.tsx"), "utf8");
    expect(dialog).not.toContain("Não há integração com tribunais nesta versão");
  });
});
