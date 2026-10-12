/**
 * DataJud provider and mapping rules, without network nor database:
 * normalization of a recorded response, CNJ -> endpoint aliases, HTTP
 * behavior (headers, batch body, retries, timeout), per-tribunal rate limit
 * and the safety rules of the phase/instance/closure mapping.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DataJudProvider,
  normalizeDataJudSource,
  parseDataJudDate,
  parseDataJudResponse,
  parseDataJudTimestamp,
} from "@/server/integrations/courts/datajud";
import { courtAliasesForCnj } from "@/server/integrations/courts/aliases";
import { SlidingWindowLimiter } from "@/server/integrations/courts/rate-limit";
import { CourtProviderError } from "@/server/integrations/courts/types";
import {
  DATAJUD_NOTE_PREFIX,
  canonicalCourt,
  courtsDiffer,
  describeComplements,
  eventTypeFor,
  hearingSituation,
  isForwardPhaseChange,
  isRemessaEmGrauDeRecurso,
  mergeVerificationNote,
  movementExternalId,
  parseCityState,
  phaseTargetFor,
  relevantKind,
  reopensCase,
  sameDescriptive,
  sameProcessClass,
} from "@/modules/court-sync/mapping";
import { PROCESS_PHASES } from "@/domain/enums";
import { cnjNumber, emGrauDeRecurso, hearing, mv } from "./helpers";

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "datajud-trt10.json"), "utf8"));
const NUMBER = "00012341820255109999";

describe("DataJud normalization (recorded response)", () => {
  const records = parseDataJudResponse("trt10", fixture);

  it("returns one record per grau with the informed fields", () => {
    expect(records.map((r) => r.grau)).toEqual(["G1", "G2"]);
    const g1 = records[0];
    expect(g1).toMatchObject({
      source: "datajud",
      alias: "trt10",
      tribunal: "TRT10",
      number: NUMBER,
      filedAt: "2025-02-28",
      secrecyLevel: 0,
      system: "PJe",
      format: "Eletrônico",
      courtDivision: { code: 99901, name: "99ª Vara do Trabalho de Brasília - DF", ibgeCode: 5300108 },
      processClass: { code: 1125, name: "Ação Trabalhista - Rito Sumaríssimo" },
    });
    expect(g1.remoteUpdatedAt).toBe("2026-09-21T19:22:34.950Z");
    expect(g1.subjects).toEqual([
      { code: 13719, name: "FGTS" },
      { code: 13998, name: "Multa de 40% do FGTS" },
      { code: 13184, name: "Honorários na Justiça do Trabalho" },
    ]);
    // ISO filing date (G2) keeps the calendar date as informed.
    expect(records[1].filedAt).toBe("2026-05-11");
  });

  it("sorts movements by date and keeps complements and duplicates as informed", () => {
    const g1 = records[0];
    const dates = g1.movements.map((m) => m.dateTime);
    expect([...dates].sort()).toEqual(dates);
    expect(g1.movements[0]).toMatchObject({ code: 26, name: "Distribuição" });
    expect(g1.movements.at(-1)).toMatchObject({ code: 123, name: "Remessa" });
    const inicial = g1.movements.find((m) => m.code === 12747)!;
    expect(hearingSituation(inicial)).toBe("designada");
    expect(describeComplements(inicial.complements)).toBe("Dirigida por: Juiz(a); Situação da audiência: designada");
    expect(g1.movements.filter((m) => m.code === 60)).toHaveLength(2);
    expect(g1.movements[0].courtDivision).toBe("99ª Vara do Trabalho de Brasília - DF");
  });

  it("never invents fields the API does not have (no parties, no amounts)", () => {
    const keys = Object.keys(records[0]).sort();
    expect(keys).toEqual(
      [
        "alias",
        "courtDivision",
        "filedAt",
        "format",
        "grau",
        "movements",
        "number",
        "processClass",
        "remoteUpdatedAt",
        "secrecyLevel",
        "source",
        "subjects",
        "system",
        "tribunal",
      ].sort(),
    );
  });

  it("rejects unknown response shapes and skips documents without number or grau", () => {
    expect(() => parseDataJudResponse("trt10", { error: "x" })).toThrow(CourtProviderError);
    expect(normalizeDataJudSource("trt10", { numeroProcesso: "123", grau: "G1" })).toBeNull();
    expect(normalizeDataJudSource("trt10", { numeroProcesso: NUMBER })).toBeNull();
  });

  it("parses the date formats the tribunals use", () => {
    expect(parseDataJudDate("20250228223933")).toBe("2025-02-28");
    expect(parseDataJudDate("20250228")).toBe("2025-02-28");
    expect(parseDataJudDate("2019-05-21T00:00:00.000Z")).toBe("2019-05-21");
    expect(parseDataJudDate("20250231000000")).toBeNull();
    expect(parseDataJudDate("ontem")).toBeNull();
    expect(parseDataJudTimestamp("2026-09-21T19:22:34.950000Z")).toBe("2026-09-21T19:22:34.950Z");
    expect(parseDataJudTimestamp(null)).toBeNull();
  });
});

describe("CNJ number -> DataJud endpoints", () => {
  it("labor (J=5): TRT of origin plus TST; TR 00 only TST", () => {
    expect(courtAliasesForCnj(cnjNumber({ seq: 1, tribunal: "10" }))).toMatchObject({ supported: true, primary: "trt10", secondary: ["tst"] });
    expect(courtAliasesForCnj(cnjNumber({ seq: 1, tribunal: "02" }))).toMatchObject({ primary: "trt2" });
    expect(courtAliasesForCnj(cnjNumber({ seq: 1, tribunal: "00" }))).toMatchObject({ primary: "tst", secondary: [] });
  });

  it("state (J=8) and federal (J=4) courts", () => {
    expect(courtAliasesForCnj(cnjNumber({ seq: 2, segment: "8", tribunal: "26" }))).toMatchObject({ primary: "tjsp", secondary: [] });
    expect(courtAliasesForCnj(cnjNumber({ seq: 2, segment: "8", tribunal: "07" }))).toMatchObject({ primary: "tjdft" });
    expect(courtAliasesForCnj(cnjNumber({ seq: 2, segment: "4", tribunal: "01" }))).toMatchObject({ primary: "trf1" });
  });

  it("other segments and malformed numbers are unsupported (no guessing)", () => {
    expect(courtAliasesForCnj(cnjNumber({ seq: 3, segment: "1", tribunal: "00" }))).toEqual({ supported: false, reason: "unsupported_segment" });
    expect(courtAliasesForCnj(cnjNumber({ seq: 3, segment: "8", tribunal: "99" }))).toEqual({ supported: false, reason: "unknown_tribunal" });
    expect(courtAliasesForCnj("123")).toEqual({ supported: false, reason: "invalid_number" });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("DataJudProvider (HTTP)", () => {
  it("sends one batch query per alias with the public key header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const provider = new DataJudProvider({
      apiKey: "chave-publica-de-teste",
      baseUrl: "https://datajud.test/",
      timeoutMs: 1000,
      limiter: new SlidingWindowLimiter(),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(fixture);
      },
    });
    const records = await provider.searchByNumbers("trt10", [NUMBER, "00000000000000000001", NUMBER, "abc"]);
    expect(records).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://datajud.test/api_publica_trt10/_search");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("APIKey chave-publica-de-teste");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.query.terms.numeroProcesso).toEqual([NUMBER, "00000000000000000001"]);
    expect(body.size).toBe(10);
  });

  it("retries 5xx and 429 with backoff, then succeeds", async () => {
    const statuses = [503, 429, 200];
    const sleeps: number[] = [];
    const provider = new DataJudProvider({
      apiKey: "k",
      baseUrl: "https://datajud.test",
      timeoutMs: 1000,
      limiter: new SlidingWindowLimiter(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      backoffBaseMs: 100,
      fetchImpl: async () => {
        const status = statuses.shift()!;
        return status === 200 ? jsonResponse(fixture) : new Response("erro interno com dados", { status });
      },
    });
    const records = await provider.searchByNumbers("trt10", [NUMBER], { attempts: 3 });
    expect(records).toHaveLength(2);
    expect(sleeps).toEqual([100, 200]);
  });

  it("does not retry a refused key and never exposes the response body", async () => {
    const fetchImpl = vi.fn(async () => new Response("segredo do servidor", { status: 401 }));
    const provider = new DataJudProvider({ apiKey: "k", baseUrl: "https://datajud.test", timeoutMs: 1000, limiter: new SlidingWindowLimiter(), fetchImpl });
    const err = await provider.searchByNumbers("trt10", [NUMBER], { attempts: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(CourtProviderError);
    expect(err.code).toBe("unauthorized");
    expect(err.message).not.toContain("segredo");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("aborts a slow request with a timeout error", async () => {
    const provider = new DataJudProvider({
      apiKey: "k",
      baseUrl: "https://datajud.test",
      timeoutMs: 20,
      limiter: new SlidingWindowLimiter(),
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    });
    const err = await provider.searchByNumbers("trt10", [NUMBER], { attempts: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(CourtProviderError);
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
  });
});

describe("per-tribunal rate limit", () => {
  it("waits when the window is full and keeps tribunals independent", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new SlidingWindowLimiter(60_000, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    await limiter.acquire("trt10", 2);
    now += 1000;
    await limiter.acquire("trt10", 2);
    await limiter.acquire("tst", 2); // another tribunal: no wait
    expect(waits).toEqual([]);
    await limiter.acquire("trt10", 2); // third call within the minute: waits until the first one leaves the window
    expect(waits).toEqual([59_000]);
    expect(limiter.waitTime("trt10", 2)).toBeGreaterThan(0);
  });

  it("the provider applies the limit per alias", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new SlidingWindowLimiter(60_000, () => now, async (ms) => {
      waits.push(ms);
      now += ms;
    });
    const provider = new DataJudProvider({ apiKey: "k", baseUrl: "https://d.test", timeoutMs: 1000, limiter, fetchImpl: async () => jsonResponse(fixture) });
    for (let i = 0; i < 3; i++) await provider.searchByNumbers("trt10", [NUMBER], { maxRequestsPerMinute: 2 });
    expect(waits).toHaveLength(1);
  });
});

describe("mapping safety rules", () => {
  it("dedupe key: same code + time + grau is one movement", () => {
    const a = mv(60, "Expedição de documento", "2025-03-05", [], "13:56:09");
    const b = mv(60, "Expedição de documento", "2025-03-05", [], "13:56:09");
    expect(movementExternalId(a, "G1")).toBe(movementExternalId(b, "g1"));
    expect(movementExternalId(a, "G1")).not.toBe(movementExternalId(a, "G2"));
  });

  it("maps event types by code/name", () => {
    expect(eventTypeFor(mv(26, "Distribuição", "2025-01-01"))).toBe("filing");
    expect(eventTypeFor(mv(12749, "de Instrução", "2025-01-01", [hearing("designada")]))).toBe("hearing");
    expect(eventTypeFor(mv(85, "Petição", "2025-01-01"))).toBe("petition");
    expect(eventTypeFor(mv(92, "Publicação", "2025-01-01"))).toBe("publication");
    expect(eventTypeFor(mv(221, "Procedência em Parte", "2025-01-01"))).toBe("decision");
    expect(eventTypeFor(mv(51, "Conclusão", "2025-01-01"))).toBe("other");
  });

  it("phase targets are only liquidation/enforcement and never 'appeal'", () => {
    expect(phaseTargetFor(mv(11384, "Liquidação iniciada", "2025-01-01"))).toBe("liquidation");
    expect(phaseTargetFor(mv(null, "Execução iniciada", "2025-01-01"))).toBe("enforcement");
    const names = ["Remessa", "Recurso Ordinário", "Conhecimento", "Recebimento", "Trânsito em julgado", "Procedência em Parte", "Agravo de Petição"];
    for (const n of names) expect(phaseTargetFor(mv(null, n, "2025-01-01"))).toBeNull();
    // Phase and instance are distinct axes (P0.5): there is no "appeal" phase at all.
    expect(PROCESS_PHASES).toEqual(["knowledge", "liquidation", "enforcement"]);
  });

  it("phase changes are forward only and never touch legacy (pre-P0.5) values", () => {
    expect(isForwardPhaseChange("knowledge", "liquidation")).toBe(true);
    expect(isForwardPhaseChange("knowledge", "enforcement")).toBe(true);
    expect(isForwardPhaseChange("appeal", "liquidation")).toBe(false);
    expect(isForwardPhaseChange("liquidation", "enforcement")).toBe(true);
    expect(isForwardPhaseChange("enforcement", "liquidation")).toBe(false);
    expect(isForwardPhaseChange("liquidation", "liquidation")).toBe(false);
    expect(isForwardPhaseChange("settlement", "enforcement")).toBe(false);
    expect(isForwardPhaseChange("closed", "enforcement")).toBe(false);
  });

  it("closure-like movements are only flagged (relevantKind), never mapped to a phase", () => {
    expect(relevantKind(mv(848, "Trânsito em julgado", "2025-01-01"))).toBe("transito");
    expect(relevantKind(mv(22, "Baixa Definitiva", "2025-01-01"))).toBe("baixa");
    expect(relevantKind(mv(246, "Arquivamento", "2025-01-01"))).toBe("arquivamento");
    expect(relevantKind(mv(null, "Arquivado Definitivamente", "2025-01-01"))).toBe("arquivamento");
    expect(relevantKind(mv(null, "Desarquivamento", "2025-01-01"))).toBeNull();
    expect(relevantKind(mv(196, "Extinção da execução ou do cumprimento da sentença", "2025-01-01"))).toBe("extincao");
    expect(relevantKind(mv(51, "Conclusão", "2025-01-01"))).toBeNull();
  });

  it("only movements that show the case going on count as a reopening after a baixa", () => {
    expect(reopensCase(mv(null, "Desarquivamento", "2025-01-01"))).toBe(true);
    expect(reopensCase(mv(132, "Recebimento", "2025-01-01"))).toBe(true);
    expect(reopensCase(mv(26, "Distribuição", "2025-01-01"))).toBe(true);
    expect(reopensCase(mv(11384, "Liquidação iniciada", "2025-01-01"))).toBe(true);
    expect(reopensCase(mv(12749, "de Instrução", "2025-01-01", [hearing("designada")]))).toBe(true);
    expect(reopensCase(mv(12749, "de Instrução", "2025-01-01", [hearing("cancelada")]))).toBe(false);
    expect(reopensCase(mv(85, "Petição", "2025-01-01"))).toBe(false);
    expect(reopensCase(mv(51, "Conclusão", "2025-01-01"))).toBe(false);
    expect(reopensCase(mv(92, "Publicação", "2025-01-01"))).toBe(false);
  });

  it("detects 'Remessa ... em grau de recurso' only with that motive", () => {
    expect(isRemessaEmGrauDeRecurso(mv(123, "Remessa", "2025-01-01", [emGrauDeRecurso]))).toBe(true);
    expect(isRemessaEmGrauDeRecurso(mv(123, "Remessa", "2025-01-01", [{ description: "motivo_da_remessa", name: "para o órgão de origem" }]))).toBe(false);
    expect(isRemessaEmGrauDeRecurso(mv(60, "Expedição de documento", "2025-01-01", [emGrauDeRecurso]))).toBe(false);
  });

  it("takes city/UF only from a clear 'de <Cidade> - <UF>' ending", () => {
    expect(parseCityState("21ª Vara do Trabalho de Brasília - DF")).toEqual({ city: "Brasília", state: "DF" });
    expect(parseCityState("1ª Vara do Trabalho do Rio de Janeiro - RJ")).toEqual({ city: "Rio de Janeiro", state: "RJ" });
    expect(parseCityState("2ª Vara Cível de Campinas - SP")).toEqual({ city: "Campinas", state: "SP" });
    expect(parseCityState("Gabinete do Desembargador Fictício")).toBeNull();
    expect(parseCityState("Vara de Família de Santos - SP")).toBeNull();
    expect(parseCityState("CEJUSC-JT de Palmas - TO")).toBeNull();
    expect(parseCityState("Vara do Trabalho de Palmas - XX")).toBeNull();
  });
});

describe("only valid CNJ numbers are queried", () => {
  it("a wrong check digit is invalid (never sent to the DataJud); the acronym can still be suggested", () => {
    const valid = cnjNumber({ seq: 4, tribunal: "10" });
    const dd = Number(valid.slice(8, 10));
    const wrong = `${valid.slice(0, 8)}${String((dd + 1) % 100).padStart(2, "0")}${valid.slice(10)}`;
    expect(courtAliasesForCnj(valid)).toMatchObject({ supported: true, primary: "trt10" });
    expect(courtAliasesForCnj(wrong)).toEqual({ supported: false, reason: "invalid_check_digit" });
    expect(courtAliasesForCnj(wrong, { allowInvalidCheckDigit: true })).toMatchObject({ supported: true, primary: "trt10" });
    // The reviewer's probe: 0000803-00.2025.5.10.0021 has a wrong check digit.
    expect(courtAliasesForCnj("0000803-00.2025.5.10.0021")).toEqual({ supported: false, reason: "invalid_check_digit" });
  });
});

describe("divergence detection (tolerant to spelling, not to content)", () => {
  it("court acronyms", () => {
    expect(canonicalCourt("TRT da 10ª Região")).toBe("TRT10");
    expect(canonicalCourt("TRT-10")).toBe("TRT10");
    expect(canonicalCourt("trt 02")).toBe("TRT2");
    expect(canonicalCourt("TJ-SP")).toBe("TJSP");
    expect(canonicalCourt("Tribunal de Justiça de São Paulo")).toBeNull();
    expect(courtsDiffer("TRT da 10ª Região", "TRT10")).toBe(false);
    expect(courtsDiffer("TRT2", "TRT10")).toBe(true);
    // Unreadable text: no divergence is claimed.
    expect(courtsDiffer("Tribunal Regional do Trabalho", "TRT10")).toBe(false);
  });

  it("court divisions and classes", () => {
    expect(sameDescriptive("21ª VT de Brasília", "21ª Vara do Trabalho de Brasília - DF")).toBe(true);
    expect(sameDescriptive("21a Vara do Trabalho de Brasilia", "21ª Vara do Trabalho de Brasília - DF")).toBe(true);
    expect(sameDescriptive("2ª Vara do Trabalho de Brasília", "21ª Vara do Trabalho de Brasília - DF")).toBe(false);
    expect(sameDescriptive("Gabinete Cadastrado Diferente", "Gabinete Fictício")).toBe(false);
    expect(sameProcessClass("ATOrd", "Ação Trabalhista - Rito Ordinário")).toBe(true);
    expect(sameProcessClass("ATSum", "Ação Trabalhista - Rito Sumaríssimo")).toBe(true);
    expect(sameProcessClass("ROT", "Recurso Ordinário Trabalhista")).toBe(true);
    expect(sameProcessClass("ATOrd", "Ação Trabalhista - Rito Sumaríssimo")).toBe(false);
  });
});

describe("verification note", () => {
  const line = (n: number) => `${DATAJUD_NOTE_PREFIX} Divergência número ${n} informada pelo tribunal. Conferir.`;

  it("appends DataJud lines after the person's text", () => {
    expect(mergeVerificationNote("Conferir a procuração.", [line(1)], 2000)).toBe(`Conferir a procuração.\n${line(1)}`);
    expect(mergeVerificationNote(null, [line(1)], 2000)).toBe(line(1));
  });

  it("drops the oldest DataJud lines first and never cuts the person's text", () => {
    const human = `Nota da equipe: ${"x".repeat(150)}`;
    let note: string = human;
    for (let i = 0; i < 40; i++) note = mergeVerificationNote(note, [line(i)], 600);
    expect(note.length).toBeLessThanOrEqual(600);
    expect(note.startsWith(human)).toBe(true);
    expect(note).toContain(line(39));
    expect(note).not.toContain(line(0));
  });

  it("when the person's text fills the space, only the newest line is shortened", () => {
    const human = "y".repeat(520);
    const note = mergeVerificationNote(human, [`${DATAJUD_NOTE_PREFIX} ${"w".repeat(200)}`], 600);
    expect(note.startsWith(human)).toBe(true);
    expect(note.length).toBeLessThanOrEqual(600);
    expect(note.endsWith("…")).toBe(true);
    // A note longer than the limit written by a person stays whole.
    const long = "z".repeat(700);
    expect(mergeVerificationNote(long, [line(2)], 600)).toBe(long);
  });
});
