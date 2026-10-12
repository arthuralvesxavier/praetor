/**
 * P0.6 process service fixes:
 * - finding 5: the confidential-view lookup filters entity_type (and skips the lock when a
 *   recent view exists);
 * - finding 12: process options without the silent 1000 cap, plus a searchable page with
 *   "N de M" and the selected ids kept;
 * - P2.12: downloads of sensitive documents (health, confidential, restricted) listed only
 *   for the documents the viewer can see.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDocumentVersion } from "@/modules/documents/service";
import {
  CONFIDENTIAL_VIEW_ACTION,
  listProcessOptions,
  listSensitiveDocumentDownloads,
  recordConfidentialProcessView,
  searchProcessOptions,
} from "@/modules/processes/service";
import type { Role } from "@/domain/enums";
import { ROLE_PERMISSIONS, type Permission } from "@/server/auth/permissions";
import { auditLogs, legalProcesses } from "@/server/db/schema";
import { ForbiddenError, NotFoundError } from "@/server/lib/errors";
import { makeProcess, makeTextDocument, setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;

beforeAll(async () => {
  f = await setupFixture("p06svc");
});

afterAll(async () => f?.teardown());

describe("confidential view log (finding 5)", () => {
  it("an entry of another entity type with the same id does not count as a recent view", async () => {
    const id = await makeProcess(f.ctx.manager, { number: "0009001-10.2026.5.10.0001", isConfidential: true, unitId: f.unitSp });
    await f.db.insert(auditLogs).values({
      organizationId: f.orgA,
      actorId: f.ctx.manager.userId,
      action: CONFIDENTIAL_VIEW_ACTION,
      entityType: "document",
      entityId: id,
      summary: "Registro de outro tipo de entidade (fictício).",
    });
    expect(await recordConfidentialProcessView(f.ctx.manager, id)).toBe(true);
    expect(await recordConfidentialProcessView(f.ctx.manager, id)).toBe(false);
    const rows = await f.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, CONFIDENTIAL_VIEW_ACTION), eq(auditLogs.entityType, "legal_process")));
    expect(rows).toHaveLength(1);
  });
});

describe("process options (finding 12)", () => {
  beforeAll(async () => {
    // 1.005 fictitious processes of unit SP, inserted directly (the cap was 1.000).
    const rows = Array.from({ length: 1005 }, (_, i) => ({
      organizationId: f.orgA,
      number: `${String(500000 + i).padStart(7, "0")}-77.2026.5.10.0001`,
      title: i === 4 ? "Processo agulha no palheiro (fictício)" : `Processo em massa ${i} (fictício)`,
      court: "TRT10",
      area: "labor" as const,
      phase: "knowledge" as const,
      unitId: f.unitSp,
    }));
    for (let i = 0; i < rows.length; i += 250) await f.db.insert(legalProcesses).values(rows.slice(i, i + 250));
    await makeProcess(f.ctx.manager, { number: "0009002-10.2026.5.10.0001", unitId: f.unitRe, title: "Processo de Recife (fictício)" });
  });

  it("lists every visible process (no silent cap)", async () => {
    const all = await listProcessOptions(f.ctx.manager);
    expect(all.length).toBeGreaterThan(1005);
    // Row scope still applies: the SP lawyer does not get the Recife process.
    const lawyer = await listProcessOptions(f.ctx.lawyer);
    expect(lawyer.some((o) => o.title === "Processo de Recife (fictício)")).toBe(false);
    expect(lawyer.filter((o) => o.number.endsWith("-77.2026.5.10.0001"))).toHaveLength(1005);
  });

  it("search page: total, shown, search by digits or title, selected ids kept", async () => {
    const first = await searchProcessOptions(f.ctx.manager, { limit: 10 });
    expect(first.shown).toBe(10);
    expect(first.total).toBeGreaterThan(1005);

    const byDigits = await searchProcessOptions(f.ctx.manager, { q: "05000047720265100001" });
    expect(byDigits.items.map((o) => o.title)).toEqual(["Processo agulha no palheiro (fictício)"]);
    expect(byDigits.total).toBe(1);

    const byTitle = await searchProcessOptions(f.ctx.manager, { q: "agulha" });
    expect(byTitle.items).toHaveLength(1);

    const keep = await searchProcessOptions(f.ctx.manager, { q: "agulha", includeIds: [first.items[9].id, "não-é-uuid"] });
    expect(keep.shown).toBe(1);
    expect(keep.items.map((o) => o.id)).toContain(first.items[9].id);

    // includeIds never reveals a process outside the viewer's scope.
    const recife = (await listProcessOptions(f.ctx.manager)).find((o) => o.title === "Processo de Recife (fictício)")!;
    const scoped = await searchProcessOptions(f.ctx.lawyer, { q: "agulha", includeIds: [recife.id] });
    expect(scoped.items.map((o) => o.id)).not.toContain(recife.id);
  });
});

describe("downloads of sensitive documents (P2.12)", () => {
  let processId: string;
  const docs: Record<string, { documentId: string; versionId: string }> = {};

  async function download(ctx: Fixture["ctx"][keyof Fixture["ctx"]], key: string) {
    const opened = await openDocumentVersion(ctx, docs[key].documentId, docs[key].versionId);
    await opened.stream.cancel();
  }

  beforeAll(async () => {
    // Responsible: the manager. The SP lawyer sees confidential documents but not restricted or health ones.
    processId = await makeProcess(f.ctx.manager, {
      number: "0009003-10.2026.5.10.0001",
      unitId: f.unitSp,
      responsibleId: f.ctx.manager.userId,
    });
    const doc = (title: string, extra: Parameters<typeof makeTextDocument>[1]) => makeTextDocument(f.ctx.manager, { title, processId, ...extra });
    docs.health = await doc("Atestado médico (fictício)", { text: "Texto fictício.", category: "sensitive_health" });
    docs.restricted = await doc("Parecer restrito (fictício)", { text: "Texto fictício.", confidentiality: "restricted" });
    docs.confidential = await doc("Acordo confidencial (fictício)", { text: "Texto fictício.", confidentiality: "confidential" });
    docs.internal = await doc("Procuração (fictícia)", { text: "Texto fictício." });
    for (const key of ["health", "restricted", "confidential", "internal"]) await download(f.ctx.manager, key);
    await download(f.ctx.lawyer, "confidential");
    await download(f.ctx.lawyer, "internal");
  });

  it("the manager sees every sensitive download, never the ordinary documents", async () => {
    const log = await listSensitiveDocumentDownloads(f.ctx.manager, processId);
    expect(log.sensitiveDocuments).toBe(3);
    expect(log.total).toBe(4);
    expect(log.items.map((i) => `${i.documentTitle}|${i.actorName}`).sort()).toEqual([
      "Acordo confidencial (fictício)|Gustavo Gestor",
      "Acordo confidencial (fictício)|Laura Advogada SP",
      "Atestado médico (fictício)|Gustavo Gestor",
      "Parecer restrito (fictício)|Gustavo Gestor",
    ]);
    const health = log.items.find((i) => i.category === "sensitive_health");
    // Health documents are stored as restricted by the documents module.
    expect(health).toMatchObject({ versionNumber: 1, confidentiality: "restricted" });
    expect(log.items.every((i) => i.at instanceof Date)).toBe(true);
  });

  it("the lawyer only sees the downloads of the documents the lawyer can open", async () => {
    const log = await listSensitiveDocumentDownloads(f.ctx.lawyer, processId);
    expect(log.sensitiveDocuments).toBe(1);
    expect(log.items.map((i) => i.documentTitle)).toEqual(["Acordo confidencial (fictício)", "Acordo confidencial (fictício)"]);
  });

  it("profiles without access to any sensitive document get nothing; other units do not see the process", async () => {
    expect(await listSensitiveDocumentDownloads(f.ctx.analyst, processId)).toEqual({ sensitiveDocuments: 0, total: 0, items: [] });
    expect(await listSensitiveDocumentDownloads(f.ctx.auditor, processId)).toEqual({ sensitiveDocuments: 0, total: 0, items: [] });
    await expect(listSensitiveDocumentDownloads(f.ctx.lawyerRe, processId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listSensitiveDocumentDownloads(f.ctx.adminB, processId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("requires document:read (refused before any query)", async () => {
    const table = ROLE_PERMISSIONS as Record<Role, readonly Permission[]>;
    const legal = table.legal_manager;
    table.legal_manager = legal.filter((p) => p !== "document:read");
    try {
      await expect(listSensitiveDocumentDownloads(f.ctx.manager, processId)).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      table.legal_manager = legal;
    }
  });

  it("a limit keeps the total", async () => {
    const log = await listSensitiveDocumentDownloads(f.ctx.manager, processId, { limit: 2 });
    expect(log.items).toHaveLength(2);
    expect(log.total).toBe(4);
  });
});
