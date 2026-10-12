/**
 * Inbound API (/api/v1) through the real route handlers on PGlite:
 * authentication by API key (401/403), organization taken from the key only,
 * validation errors with field paths, idempotency, RN-01 (existing CNJ ->
 * documents attached, never a duplicate), document limits (count, size, magic
 * bytes), per-key rate limit (429), status endpoint, OpenAPI, and the DataJud
 * enrichment (fill-empty only) with a fake court provider.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { POST as postProcess } from "@/app/api/v1/processos/route";
import { GET as getStatus } from "@/app/api/v1/processos/[numero]/route";
import { GET as getOpenApi } from "@/app/api/v1/openapi.json/route";
import { apiKeys, auditLogs, caseIntakes, documents, inboundRequests, legalProcesses, processEvents, processParties } from "@/server/db/schema";
import { createApiKey, revokeApiKey } from "@/modules/api-keys/service";
import { consumeInboundQuota, INBOUND_REQUESTS_PER_MINUTE, resetInboundQuotas } from "@/modules/inbound/rate-limit";
import { FakeCourtProvider } from "@/server/integrations/courts/fake";
import { setCourtProviderForTesting } from "@/server/integrations/courts";
import { resetEnvCache } from "@/server/env";
import { ForbiddenError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";
import { cnjNumber, digitsOf, mv, rec } from "../court-sync/helpers";

let f: Fixture;
let keyFull: string; // intake:create + process:read
let keyIntakeOnly: string;
let keyReadOnly: string;
let keyB: string; // organization B
let keyFullId: string;
let seq = 300;

const PDF = Buffer.from("%PDF-1.4\n% documento ficticio de teste\n%%EOF\n").toString("base64");
const TXT = Buffer.from("Petição inicial fictícia para teste.").toString("base64");

function nextNumber(tribunal = "10"): string {
  seq += 1;
  return cnjNumber({ seq, tribunal, year: 2026 });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    numero: nextNumber(),
    tribunal: "TRT10",
    cidade: "Palmas",
    uf: "TO",
    classe: "ATOrd",
    valorDaCausa: "12345.67",
    partes: [
      { nome: "Pessoa Autora Fictícia", polo: "ativo", documento: "52998224725" },
      { nome: "Empresa Fictícia A Ltda.", polo: "passivo" },
      { nome: "Testemunha Fictícia", polo: "terceiro" },
    ],
    documentos: [
      { titulo: "Petição inicial", categoria: "initial_petition", nomeArquivo: "inicial.pdf", conteudoBase64: PDF },
      { titulo: "Resumo", nomeArquivo: "resumo.txt", conteudoBase64: TXT },
    ],
    origem: { sistema: "ERP Fictício", referencia: "REQ-1" },
    ...overrides,
  };
}

function post(body: unknown, opts: { key?: string | null; idem?: string; contentType?: string; raw?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": opts.contentType ?? "application/json" };
  if (opts.key !== null) headers.Authorization = `Bearer ${opts.key ?? keyFull}`;
  if (opts.idem) headers["Idempotency-Key"] = opts.idem;
  return postProcess(new Request("http://localhost:3000/api/v1/processos", { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) }));
}

function status(numero: string, key = keyFull) {
  return getStatus(
    new Request(`http://localhost:3000/api/v1/processos/${numero}`, { headers: { Authorization: `Bearer ${key}` } }),
    { params: Promise.resolve({ numero }) } as never,
  );
}

async function processByNumber(orgId: string, number: string) {
  return f.db
    .select()
    .from(legalProcesses)
    .where(and(eq(legalProcesses.organizationId, orgId), eq(legalProcesses.number, number), sql`${legalProcesses.deletedAt} is null`));
}

beforeAll(async () => {
  f = await setupFixture("api");
  setCourtProviderForTesting(null);
  const full = await createApiKey(f.ctx.admin, { name: "ERP Fictício", scopes: ["intake:create", "process:read"] });
  keyFull = full.key;
  keyFullId = full.id;
  keyIntakeOnly = (await createApiKey(f.ctx.admin, { name: "Só envio", scopes: ["intake:create"] })).key;
  keyReadOnly = (await createApiKey(f.ctx.admin, { name: "Só consulta", scopes: ["process:read"] })).key;
  keyB = (await createApiKey(f.ctx.adminB, { name: "Org B", scopes: ["intake:create", "process:read"] })).key;
});

beforeEach(() => resetInboundQuotas());

afterAll(async () => {
  setCourtProviderForTesting(undefined);
  await f?.teardown();
});

describe("API keys", () => {
  it("shows the key once, stores only its hash, and only admins manage keys", async () => {
    expect(keyFull).toMatch(/^prt_[A-Za-z0-9_-]{43}$/);
    const [row] = await f.db.select().from(apiKeys).where(eq(apiKeys.id, keyFullId));
    expect(row.keyHash).toHaveLength(64);
    expect(row.keyHash).not.toContain(keyFull.slice(4, 20));
    expect(keyFull.startsWith(row.keyPrefix)).toBe(true);
    await expect(createApiKey(f.ctx.manager, { name: "x123", scopes: ["intake:create"] })).rejects.toBeInstanceOf(ForbiddenError);
    const audit = await f.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, keyFullId), eq(auditLogs.action, "api_key.create")));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain(keyFull);
  });
});

describe("authentication and scopes", () => {
  it("401 without, with malformed, unknown, revoked or expired keys", async () => {
    expect((await post(payload(), { key: null })).status).toBe(401);
    expect((await post(payload(), { key: "abc" })).status).toBe(401);
    expect((await post(payload(), { key: `prt_${"A".repeat(43)}` })).status).toBe(401);
    const revoked = await createApiKey(f.ctx.admin, { name: "Revogada", scopes: ["intake:create"] });
    await revokeApiKey(f.ctx.admin, revoked.id);
    const res = await post(payload(), { key: revoked.key });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    const expired = await createApiKey(f.ctx.admin, { name: "Expirada", scopes: ["intake:create"] });
    await f.db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, expired.id));
    expect((await post(payload(), { key: expired.key })).status).toBe(401);
  });

  it("403 when the key lacks the scope", async () => {
    const res = await post(payload(), { key: keyReadOnly });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect((await status("00000000000000000000", keyIntakeOnly)).status).toBe(403);
  });

  it("the organization always comes from the key, never from the body", async () => {
    const body = payload({ organizationId: f.orgB, organizacao: f.orgB });
    const res = await post(body, { key: keyFull });
    expect(res.status).toBe(201);
    expect(await processByNumber(f.orgA, body.numero as string)).toHaveLength(1);
    expect(await processByNumber(f.orgB, body.numero as string)).toHaveLength(0);
    // The same number sent by organization B is a different process of B (no cross-organization dedupe).
    const resB = await post(body, { key: keyB });
    expect(resB.status).toBe(201);
    expect(await processByNumber(f.orgB, body.numero as string)).toHaveLength(1);
  });
});

describe("POST /api/v1/processos", () => {
  it("201: registers the process through the intake pipeline (source api)", async () => {
    const body = payload();
    const res = await post(body);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({ status: "accepted", number: body.numero, documents: 2 });
    expect(json.links.process).toContain(`/processos/${json.processId}`);
    expect(json.links.status).toContain(digitsOf(body.numero as string));
    const [p] = await processByNumber(f.orgA, body.numero as string);
    expect(p).toMatchObject({ court: "TRT10", city: "Palmas", state: "TO", processClass: "ATOrd", area: "labor", claimAmountCents: 1234567 });
    const [intake] = await f.db.select().from(caseIntakes).where(eq(caseIntakes.id, json.intakeId));
    expect(intake.source).toBe("api");
    expect(intake.steps[0].detail).toContain("ERP Fictício");
    expect(intake.steps[0].actorName).toBe("API: ERP Fictício");
    const parties = await f.db.select().from(processParties).where(eq(processParties.processId, p.id));
    expect(parties.map((x) => [x.role, x.name]).sort()).toEqual([
      ["defendant", "Empresa Fictícia A Ltda."],
      ["plaintiff", "Pessoa Autora Fictícia"],
      ["third_party", "Testemunha Fictícia"],
    ]);
    expect(parties.find((x) => x.role === "plaintiff")?.documentNumber).toBe("52998224725");
    expect(parties.find((x) => x.role === "defendant")?.isClient).toBe(true); // matched the company by name
    const docs = await f.db.select().from(documents).where(eq(documents.processId, p.id));
    expect(docs).toHaveLength(2);
    const [log] = await f.db.select().from(inboundRequests).where(eq(inboundRequests.processId, p.id));
    expect(log).toMatchObject({ status: "accepted", httpStatus: 201 });
    const audit = await f.db.select().from(auditLogs).where(eq(auditLogs.action, "inbound.receive"));
    expect(audit.some((a) => a.summary.includes("ERP Fictício"))).toBe(true);
  });

  it("400 with field paths in pt-BR", async () => {
    const res = await post({
      numero: "123",
      partes: [{ nome: "", polo: "reu" }],
      valorDaCausa: "12.345,67",
      origem: {},
    });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe("validation");
    expect(error.fieldErrors.numero[0]).toContain("padrão CNJ");
    expect(error.fieldErrors["partes.0.polo"][0]).toContain("polo válido");
    expect(error.fieldErrors["partes.0.nome"]).toBeTruthy();
    expect(error.fieldErrors.valorDaCausa[0]).toContain("12345.67");
    expect(error.fieldErrors["origem.sistema"]).toBeTruthy();
    expect((await post(null, { raw: "{nao e json" })).status).toBe(400);
    expect((await post(payload(), { contentType: "text/plain" })).status).toBe(415);
    const noPlaintiff = await post(payload({ partes: [{ nome: "Só Ré", polo: "passivo" }] }));
    expect(noPlaintiff.status).toBe(400);
    expect((await noPlaintiff.json()).error.fieldErrors.partes[0]).toContain("polo ativo");
  });

  it("P0.5: fase and instancia are distinct fields; a phase of the previous model is refused", async () => {
    const body = payload({ fase: "enforcement", instancia: "second", documentos: [] });
    const res = await post(body);
    expect(res.status).toBe(201);
    const [p] = await processByNumber(f.orgA, body.numero as string);
    expect(p).toMatchObject({ phase: "enforcement", instance: "second" });

    const byDefault = payload({ documentos: [] });
    expect((await post(byDefault)).status).toBe(201);
    expect((await processByNumber(f.orgA, byDefault.numero as string))[0]).toMatchObject({ phase: "knowledge", instance: "first" });

    const legacy = await post(payload({ fase: "appeal", instancia: "2º grau", documentos: [] }));
    expect(legacy.status).toBe(400);
    const { error } = await legacy.json();
    expect(error.fieldErrors.fase[0]).toContain("instancia");
    expect(error.fieldErrors.instancia[0]).toContain("first, second, superior");

    const openapi = await (await getOpenApi()).json();
    const props = openapi.components.schemas.InboundProcess.properties;
    expect(props.fase.enum).toEqual(["knowledge", "liquidation", "enforcement"]);
    expect(props.instancia.enum).toEqual(["first", "second", "superior"]);
  });

  it("idempotency: same key and body -> same response; other body -> 422", async () => {
    const body = payload();
    const first = await post(body, { idem: "pedido-001" });
    expect(first.status).toBe(201);
    const a = await first.json();
    const again = await post(body, { idem: "pedido-001" });
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    const b = await again.json();
    expect(b.processId).toBe(a.processId);
    expect(b.intakeId).toBe(a.intakeId);
    expect(await processByNumber(f.orgA, body.numero as string)).toHaveLength(1);
    const other = await post(payload(), { idem: "pedido-001" });
    expect(other.status).toBe(422);
    // The same Idempotency-Key is independent per API key.
    expect((await post(payload(), { idem: "pedido-001", key: keyIntakeOnly })).status).toBe(201);
    // A refused request releases its Idempotency-Key.
    expect((await post({ ...payload(), partes: [] }, { idem: "pedido-002" })).status).toBe(400);
    expect((await post(payload(), { idem: "pedido-002" })).status).toBe(201);
  });

  it("RN-01: an existing CNJ number gets the documents and a note, never a duplicate (200)", async () => {
    const number = nextNumber();
    const processId = await makeProcess(f.ctx.admin, { number, court: "TRT10", area: "labor", phase: "knowledge", processClass: "ROT" });
    const res = await post(payload({ numero: number, classe: "ATSum", cidade: "Outra" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ status: "updated_existing", processId, documents: 2 });
    const rows = await processByNumber(f.orgA, number);
    expect(rows).toHaveLength(1);
    expect(rows[0].processClass).toBe("ROT"); // nothing overwritten
    expect(rows[0].city).toBeNull();
    expect(await f.db.select().from(documents).where(eq(documents.processId, processId))).toHaveLength(2);
    const audit = await f.db.select().from(auditLogs).where(and(eq(auditLogs.entityId, processId), eq(auditLogs.action, "inbound.update_existing")));
    expect(audit).toHaveLength(1);

    // With an intake, the note is appended to its timeline.
    const sent = payload();
    const created = await (await post(sent)).json();
    await post(payload({ numero: sent.numero, documentos: [] }));
    const [intake] = await f.db.select().from(caseIntakes).where(eq(caseIntakes.id, created.intakeId));
    expect(intake.steps.at(-1)?.detail).toContain("processo já cadastrado");
  });

  it("document limits: count, magic bytes, extension and size", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ titulo: `Doc ${i}`, nomeArquivo: `d${i}.txt`, conteudoBase64: TXT }));
    const r1 = await post(payload({ documentos: many }));
    expect(r1.status).toBe(400);
    expect((await r1.json()).error.fieldErrors.documentos[0]).toContain("20");

    const fakePdf = await post(payload({ documentos: [{ titulo: "x", nomeArquivo: "x.pdf", conteudoBase64: TXT }] }));
    expect(fakePdf.status).toBe(400);
    expect((await fakePdf.json()).error.fieldErrors["documentos.0.conteudoBase64"][0]).toContain(".pdf");

    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
    const r3 = await post(payload({ documentos: [{ titulo: "x", nomeArquivo: "x.txt", conteudoBase64: html }] }));
    expect(r3.status).toBe(400);

    const exe = await post(payload({ documentos: [{ titulo: "x", nomeArquivo: "x.exe", conteudoBase64: PDF }] }));
    expect((await exe.json()).error.fieldErrors["documentos.0.nomeArquivo"]).toBeTruthy();

    const previous = process.env.MAX_UPLOAD_MB;
    process.env.MAX_UPLOAD_MB = "0.0001"; // ~104 bytes
    resetEnvCache();
    try {
      const big = Buffer.from(`%PDF-1.4\n${"x".repeat(500)}`).toString("base64");
      const r4 = await post(payload({ documentos: [{ titulo: "x", nomeArquivo: "x.pdf", conteudoBase64: big }] }));
      expect(r4.status).toBe(400);
      expect((await r4.json()).error.fieldErrors["documentos.0.conteudoBase64"][0]).toContain("limite");
    } finally {
      if (previous === undefined) delete process.env.MAX_UPLOAD_MB;
      else process.env.MAX_UPLOAD_MB = previous;
      resetEnvCache();
    }
  });

  it("429 with Retry-After when the key exceeds the per-minute limit", async () => {
    const [row] = await f.db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, keyFullId));
    for (let i = 0; i < INBOUND_REQUESTS_PER_MINUTE; i++) expect(consumeInboundQuota(row.id).ok).toBe(true);
    const res = await post(payload());
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Another key is not affected.
    expect((await post(payload(), { key: keyIntakeOnly })).status).toBe(201);
    const [log] = await f.db
      .select()
      .from(inboundRequests)
      .where(and(eq(inboundRequests.apiKeyId, keyFullId), eq(inboundRequests.errorCode, "rate_limited")));
    expect(log.httpStatus).toBe(429);
  });
});

describe("GET /api/v1/processos/{numero} and the OpenAPI document", () => {
  it("returns the minimal status of processes sent through the API only", async () => {
    const body = payload();
    await post(body);
    const res = await status(digitsOf(body.numero as string));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ number: body.numero, phase: "knowledge", intake: { status: "received" } });
    expect(json.preliminaryAnalysis).toBeNull();
    // A process that was not received by API is not exposed.
    const other = nextNumber();
    await makeProcess(f.ctx.admin, { number: other, court: "TRT10", area: "labor", phase: "knowledge" });
    expect((await status(other)).status).toBe(404);
    expect((await status("123")).status).toBe(400);
    // Another organization's key never sees it.
    expect((await status(body.numero as string, keyB)).status).toBe(404);
  });

  it("serves the OpenAPI contract without authentication", async () => {
    const res = await getOpenApi();
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(["/api/v1/processos", "/api/v1/processos/{numero}"]);
    expect(JSON.stringify(doc)).not.toMatch(/—|–/);
  });
});

describe("DataJud enrichment on arrival", () => {
  it("fills only the empty fields and imports the movements", async () => {
    const fake = new FakeCourtProvider();
    setCourtProviderForTesting(fake);
    try {
      const number = nextNumber();
      fake.add("trt10", rec(number, { filedAt: "2026-01-15", movements: [mv(26, "Distribuição", "2026-01-15"), mv(85, "Petição", "2026-02-01")] }));
      const res = await post(payload({ numero: number, tribunal: undefined, cidade: undefined, uf: undefined, classe: undefined }));
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.datajud).toContain("DataJud");
      const [p] = await processByNumber(f.orgA, number);
      expect(p).toMatchObject({
        court: "TRT10",
        courtDivision: "21ª Vara do Trabalho de Brasília - DF",
        city: "Brasília",
        state: "DF",
        processClass: "Ação Trabalhista - Rito Sumaríssimo",
        filedAt: "2026-01-15",
      });
      const events = await f.db.select().from(processEvents).where(eq(processEvents.processId, p.id));
      expect(events).toHaveLength(2);
      expect(fake.calls.map((c) => c.alias)).toEqual(["trt10", "tst"]);

      // Values sent by the external system are never replaced.
      const kept = nextNumber();
      fake.add("trt10", rec(kept, { movements: [mv(26, "Distribuição", "2026-01-15")] }));
      await post(payload({ numero: kept, cidade: "Gurupi", uf: "TO", classe: "ATOrd" }));
      const [q] = await processByNumber(f.orgA, kept);
      expect(q).toMatchObject({ city: "Gurupi", state: "TO", processClass: "ATOrd" });
    } finally {
      setCourtProviderForTesting(null);
    }
  });
});
