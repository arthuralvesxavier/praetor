import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addDocumentVersion,
  deleteDocument,
  extractDocumentVersionText,
  getDocument,
  listDocuments,
  openDocumentVersion,
  updateDocumentMetadata,
  uploadDocument,
} from "@/modules/documents/service";
import type { AuthContext } from "@/server/auth/context";
import type { Database } from "@/server/db/client";
import { auditLogs, documentVersions, jobs, legalProcesses, organizations, units, users } from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import { buildStorageKey, getStorage, LocalStorageProvider, readStreamToBytes, setStorageForTesting } from "@/server/integrations/storage";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";
import { createTestDatabase } from "../helpers/db";
import { buildDocx, utf8 } from "./fixtures";

let db: Database;
let close: () => Promise<void>;
let storageDir: string;
const ids: Record<string, string> = {};

function ctx(role: AuthContext["role"], userId: string, orgId: string, unitId: string | null): AuthContext {
  return { kind: "user", userId, organizationId: orgId, role, unitId, name: role, email: `${role}@x`, isDemoOrganization: false };
}

let admin: AuthContext;
let manager: AuthContext;
let lawyerSp: AuthContext;
let analystSp: AuthContext;
let executive: AuthContext;
let adminB: AuthContext;

const txt = (name: string, text: string) => ({ name, bytes: utf8(text) });

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), "praetor-docs-"));
  process.env.STORAGE_DIR = storageDir;
  resetEnvCache();
  setStorageForTesting(new LocalStorageProvider(storageDir));

  ({ db, close } = await createTestDatabase());
  const [a] = await db.insert(organizations).values({ name: "A", slug: "a" }).returning();
  const [b] = await db.insert(organizations).values({ name: "B", slug: "b" }).returning();
  const [sp] = await db.insert(units).values({ organizationId: a.id, name: "SP" }).returning();
  const [re] = await db.insert(units).values({ organizationId: a.id, name: "RE" }).returning();
  const mk = async (org: string, email: string, role: AuthContext["role"], unitId: string | null) =>
    (await db.insert(users).values({ organizationId: org, name: email, email, passwordHash: "x", role, unitId }).returning())[0];
  const uAdmin = await mk(a.id, "admin@a", "admin", null);
  const uManager = await mk(a.id, "gestor@a", "legal_manager", null);
  const uLawyer = await mk(a.id, "adv@a", "lawyer", sp.id);
  const uAnalyst = await mk(a.id, "analista@a", "analyst", sp.id);
  const uExec = await mk(a.id, "exec@a", "executive", null);
  const uAdminB = await mk(b.id, "admin@b", "admin", null);

  admin = ctx("admin", uAdmin.id, a.id, null);
  manager = ctx("legal_manager", uManager.id, a.id, null);
  lawyerSp = ctx("lawyer", uLawyer.id, a.id, sp.id);
  analystSp = ctx("analyst", uAnalyst.id, a.id, sp.id);
  executive = ctx("executive", uExec.id, a.id, null);
  adminB = ctx("admin", uAdminB.id, b.id, null);

  const base = { organizationId: a.id, court: "TJSP", area: "civil" as const, phase: "knowledge" as const };
  const [pSp] = await db.insert(legalProcesses).values({ ...base, number: "0001", title: "Processo SP", unitId: sp.id }).returning();
  const [pRe] = await db.insert(legalProcesses).values({ ...base, number: "0002", title: "Processo RE", unitId: re.id }).returning();
  const [pB] = await db
    .insert(legalProcesses)
    .values({ ...base, organizationId: b.id, number: "0003", title: "Processo B" })
    .returning();
  Object.assign(ids, { orgA: a.id, orgB: b.id, pSp: pSp.id, pRe: pRe.id, pB: pB.id });
});

afterAll(async () => {
  setStorageForTesting(undefined);
  await close();
  await rm(storageDir, { recursive: true, force: true });
});

describe("uploadDocument", () => {
  it("creates the document, version 1, the blob, the audit entry and the extraction job", async () => {
    const result = await uploadDocument(lawyerSp, {
      title: "Contestação",
      category: "petition",
      processId: ids.pSp,
      file: txt("contestacao.txt", "Texto da contestação — confidencial"),
    });
    ids.doc1 = result.documentId;
    ids.doc1v1 = result.versionId;

    const doc = await getDocument(lawyerSp, result.documentId);
    expect(doc).toMatchObject({ title: "Contestação", currentVersionId: result.versionId, currentVersionNumber: 1, processId: ids.pSp });
    expect(doc.links).toEqual([{ type: "legal_process", id: ids.pSp, label: "0001 · Processo SP" }]);
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0]).toMatchObject({ fileName: "contestacao.txt", mimeType: "text/plain", extractionStatus: "pending", isCurrent: true });

    const key = buildStorageKey(ids.orgA, result.documentId, result.versionId);
    expect(await getStorage().exists(key)).toBe(true);

    const [job] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `extract:${result.versionId}`));
    expect(job).toMatchObject({ type: "document.extract_text", organizationId: ids.orgA, status: "queued" });
    expect(job.payload).toEqual({ versionId: result.versionId });

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, result.documentId), eq(auditLogs.action, "document.upload")));
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toContain("Texto da contestação");
    expect(audit.metadata).toMatchObject({ fileName: "contestacao.txt", mimeType: "text/plain" });
  });

  it("rejects links to records the user cannot see (other unit, other organization)", async () => {
    await expect(
      uploadDocument(lawyerSp, { title: "x", category: "other", processId: ids.pRe, file: txt("a.txt", "a") }),
    ).rejects.toMatchObject({ code: "validation", fieldErrors: { processId: expect.any(Array) } });
    await expect(
      uploadDocument(admin, { title: "x", category: "other", processId: ids.pB, file: txt("a.txt", "a") }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("removes the stored blob when the transaction fails", async () => {
    const real = getStorage();
    const calls: string[] = [];
    setStorageForTesting({
      put: async (key, bytes) => {
        calls.push(`put:${key}`);
        await real.put(key, bytes);
      },
      delete: async (key) => {
        calls.push(`delete:${key}`);
        await real.delete(key);
      },
      getStream: (key) => real.getStream(key),
      exists: (key) => real.exists(key),
    });
    try {
      // Organization that does not exist -> foreign key violation inside the transaction.
      const ghost = { ...admin, organizationId: "99999999-9999-4999-8999-999999999999" };
      await expect(uploadDocument(ghost, { title: "x", category: "other", file: txt("a.txt", "a") })).rejects.toThrow();
      expect(calls).toHaveLength(2);
      const key = calls[0].slice("put:".length);
      expect(calls[1]).toBe(`delete:${key}`);
      expect(await real.exists(key)).toBe(false);
    } finally {
      setStorageForTesting(real);
    }
  });

  it("requires document:upload and validates the file", async () => {
    await expect(uploadDocument(executive, { title: "x", category: "other", file: txt("a.txt", "a") })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      uploadDocument(lawyerSp, { title: "x", category: "other", file: { name: "a.pdf", bytes: utf8("não é pdf") } }),
    ).rejects.toMatchObject({ fieldErrors: { file: expect.any(Array) } });
    await expect(
      uploadDocument(lawyerSp, { title: " ", category: "bogus" as never, file: txt("a.txt", "a") }),
    ).rejects.toMatchObject({ fieldErrors: { title: expect.any(Array), category: expect.any(Array) } });
  });
});

describe("tenant isolation and visibility", () => {
  it("another organization's admin gets NotFoundError", async () => {
    await expect(getDocument(adminB, ids.doc1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(openDocumentVersion(adminB, ids.doc1, ids.doc1v1)).rejects.toBeInstanceOf(NotFoundError);
    await expect(addDocumentVersion(adminB, ids.doc1, { file: txt("b.txt", "b") })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteDocument(adminB, ids.doc1)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listDocuments(adminB, {})).total).toBe(0);
  });

  it("invalid ids are reported as not found", async () => {
    await expect(getDocument(admin, "not-a-uuid")).rejects.toBeInstanceOf(NotFoundError);
    await expect(openDocumentVersion(admin, ids.doc1, "../../etc/passwd")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("restricted documents are hidden from analysts and lawyers who are not responsible", async () => {
    const { documentId, versionId } = await uploadDocument(admin, {
      title: "Parecer restrito",
      category: "report",
      confidentiality: "restricted",
      processId: ids.pSp,
      file: txt("parecer.txt", "parecer"),
    });
    ids.restricted = documentId;
    const analystList = await listDocuments(analystSp, {});
    expect(analystList.items.map((d) => d.id)).not.toContain(documentId);
    expect(analystList.items.map((d) => d.id)).toContain(ids.doc1);
    await expect(getDocument(analystSp, documentId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(openDocumentVersion(analystSp, documentId, versionId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getDocument(lawyerSp, documentId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getDocument(manager, documentId)).confidentiality).toBe("restricted");
  });

  it("a version id of another document is not served", async () => {
    const [restrictedVersion] = await db
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, ids.restricted));
    await expect(openDocumentVersion(lawyerSp, ids.doc1, restrictedVersion.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("versions, download and extraction", () => {
  it("rejects a version identical to the current one and adds a new version otherwise", async () => {
    await expect(
      addDocumentVersion(lawyerSp, ids.doc1, { file: txt("outro-nome.txt", "Texto da contestação — confidencial") }),
    ).rejects.toMatchObject({ code: "validation", fieldErrors: { file: expect.any(Array) } });

    const v2 = await addDocumentVersion(lawyerSp, ids.doc1, {
      changeNote: "Revisão",
      file: { name: "contestacao-v2.docx", bytes: buildDocx("Contestação revisada\nSegunda linha") },
    });
    expect(v2.versionNumber).toBe(2);
    ids.doc1v2 = v2.versionId;
    const doc = await getDocument(lawyerSp, ids.doc1);
    expect(doc.currentVersionNumber).toBe(2);
    expect(doc.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(doc.versions[0]).toMatchObject({ isCurrent: true, changeNote: "Revisão" });
  });

  it("opens a version as a stream and audits the download", async () => {
    const file = await openDocumentVersion(analystSp, ids.doc1, ids.doc1v1);
    expect(file).toMatchObject({ fileName: "contestacao.txt", mimeType: "text/plain" });
    const bytes = await readStreamToBytes(file.stream, 1024);
    expect(new TextDecoder().decode(bytes)).toBe("Texto da contestação — confidencial");
    const downloads = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ids.doc1), eq(auditLogs.action, "document.download")));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].actorId).toBe(analystSp.userId);
  });

  it("extracts text idempotently and exposes a preview", async () => {
    await extractDocumentVersionText(ids.doc1v2);
    await extractDocumentVersionText(ids.doc1v2); // no-op the second time
    const [v] = await db.select().from(documentVersions).where(eq(documentVersions.id, ids.doc1v2));
    expect(v.extractionStatus).toBe("succeeded");
    expect(v.extractedText).toContain("Contestação revisada");
    const doc = await getDocument(lawyerSp, ids.doc1);
    expect(doc.textPreview).toMatchObject({ versionNumber: 2, truncated: false });
    expect(doc.textPreview?.text).toContain("Segunda linha");
  });

  it("marks the version as failed when the blob is missing", async () => {
    await getStorage().delete(buildStorageKey(ids.orgA, ids.doc1, ids.doc1v1));
    await extractDocumentVersionText(ids.doc1v1);
    const [v] = await db.select().from(documentVersions).where(eq(documentVersions.id, ids.doc1v1));
    expect(v.extractionStatus).toBe("failed");
    await expect(openDocumentVersion(admin, ids.doc1, ids.doc1v1)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("metadata, legal hold and deletion", () => {
  it("updates metadata with audit and checks links", async () => {
    await updateDocumentMetadata(lawyerSp, ids.doc1, { title: "Contestação (final)", retentionUntil: "2031-12-31" });
    const doc = await getDocument(lawyerSp, ids.doc1);
    expect(doc).toMatchObject({ title: "Contestação (final)", retentionUntil: "2031-12-31" });
    await expect(updateDocumentMetadata(lawyerSp, ids.doc1, { processId: ids.pRe })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateDocumentMetadata(lawyerSp, ids.doc1, { retentionUntil: "2031-02-30" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, ids.doc1), eq(auditLogs.action, "document.update")));
    expect(audit.changes).toMatchObject({ title: { from: "Contestação", to: "Contestação (final)" } });
  });

  it("only users with document:delete may set legal hold; legal hold blocks deletion", async () => {
    await expect(updateDocumentMetadata(lawyerSp, ids.doc1, { legalHold: true })).rejects.toBeInstanceOf(ForbiddenError);
    await updateDocumentMetadata(manager, ids.doc1, { legalHold: true });
    await expect(deleteDocument(manager, ids.doc1)).rejects.toBeInstanceOf(ConflictError);
    await expect(deleteDocument(lawyerSp, ids.doc1)).rejects.toBeInstanceOf(ForbiddenError);
    await updateDocumentMetadata(manager, ids.doc1, { legalHold: false });
    await deleteDocument(manager, ids.doc1);
    await expect(getDocument(manager, ids.doc1)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listDocuments(manager, {})).items.map((d) => d.id)).not.toContain(ids.doc1);
  });

  it("filters the list by text and category", async () => {
    const list = await listDocuments(manager, { q: "parecer", category: "report" });
    expect(list.items.map((d) => d.id)).toEqual([ids.restricted]);
    expect((await listDocuments(manager, { q: "100%_" })).total).toBe(0);
  });
});
