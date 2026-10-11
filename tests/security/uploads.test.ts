/**
 * Upload hardening through the real documents service: disguised files
 * (HTML/SVG/executables renamed to .pdf), oversize and empty files, file names
 * with paths, and storage keys that try to escape the storage root.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDocument, openDocumentVersion, uploadDocument, type UploadFile } from "@/modules/documents/service";
import { documents, documentVersions, jobs } from "@/server/db/schema";
import { resetEnvCache } from "@/server/env";
import {
  assertValidStorageKey,
  buildStorageKey,
  getStorage,
  InvalidStorageKeyError,
  LocalStorageProvider,
  readStreamToBytes,
} from "@/server/integrations/storage";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import { makeProcess, makeTextDocument, setupFixture, utf8, type Fixture } from "../helpers/fixtures";

let f: Fixture;
let processId: string;

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === "string" ? utf8(p) : new Uint8Array(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

async function rejectsUpload(file: UploadFile): Promise<ValidationError> {
  const err = await uploadDocument(f.ctx.lawyer, { title: "Arquivo suspeito", category: "other", processId, file }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, file.name).toBeInstanceOf(ValidationError);
  const v = err as ValidationError;
  expect(v.fieldErrors?.file?.length, file.name).toBeGreaterThan(0);
  return v;
}

beforeAll(async () => {
  f = await setupFixture("upl");
  processId = await makeProcess(f.ctx.admin, { unitId: f.unitSp });
});

afterAll(async () => {
  delete process.env.MAX_UPLOAD_MB;
  resetEnvCache();
  await f.teardown();
});

describe("disguised and dangerous files", () => {
  it("rejects HTML, SVG, XML and executables renamed to .pdf (and HTML renamed to .txt)", async () => {
    await rejectsUpload({ name: "relatorio.pdf", bytes: utf8("<!DOCTYPE html><html><script>alert(1)</script></html>") });
    await rejectsUpload({ name: "relatorio.pdf", bytes: utf8("<html><body onload=alert(1)>x</body></html>") });
    await rejectsUpload({
      name: "grafico.pdf",
      bytes: utf8('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    await rejectsUpload({ name: "dados.pdf", bytes: utf8('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>') });
    await rejectsUpload({ name: "programa.pdf", bytes: bytes([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00], "This program cannot be run in DOS mode") });
    await rejectsUpload({ name: "script.pdf", bytes: bytes([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]) });
    await rejectsUpload({ name: "pagina.txt", bytes: utf8("<html><script>document.cookie</script></html>") });
    await rejectsUpload({ name: "imagem.txt", bytes: utf8("  <svg onload=alert(1)></svg>") });
  });

  it("rejects forbidden extensions even with valid content, and content/extension mismatches", async () => {
    await rejectsUpload({ name: "documento.exe", bytes: utf8("%PDF-1.4\n%fake\n") });
    await rejectsUpload({ name: "pagina.html", bytes: utf8("texto simples") });
    await rejectsUpload({ name: "imagem.svg", bytes: utf8("texto simples") });
    await rejectsUpload({ name: "sem-extensao", bytes: utf8("texto simples") });
    await rejectsUpload({ name: "foto.png", bytes: utf8("%PDF-1.4\n%fake\n") }); // PDF bytes named .png
    await rejectsUpload({ name: "planilha.docx", bytes: bytes([0x50, 0x4b, 0x03, 0x04], "not a real docx") });
    await rejectsUpload({ name: "antigo.doc", bytes: bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) });
  });

  it("rejects empty and oversize files", async () => {
    await rejectsUpload({ name: "vazio.txt", bytes: new Uint8Array(0) });

    process.env.MAX_UPLOAD_MB = "1";
    resetEnvCache();
    try {
      const big = new Uint8Array(1024 * 1024 + 1).fill(0x61); // "aaaa…" plain text, 1 MB + 1 byte
      const err = await rejectsUpload({ name: "grande.txt", bytes: big });
      expect(err.message).toMatch(/excede o limite de 1 MB/);
      // Exactly at the limit is accepted.
      await uploadDocument(f.ctx.lawyer, {
        title: "No limite",
        category: "other",
        processId,
        file: { name: "limite.txt", bytes: new Uint8Array(1024 * 1024).fill(0x62) },
      });
    } finally {
      delete process.env.MAX_UPLOAD_MB;
      resetEnvCache();
    }
  });

  it("rejected uploads leave no rows, no jobs and no blobs behind", async () => {
    const docs = await f.db.select().from(documents).where(eq(documents.organizationId, f.orgA));
    expect(docs.map((d) => d.title)).toEqual(["No limite"]);
    const versions = await f.db.select().from(documentVersions);
    expect(versions).toHaveLength(1);
    const extractJobs = await f.db.select().from(jobs).where(eq(jobs.type, "document.extract_text"));
    expect(extractJobs).toHaveLength(1);
    const files = await listFiles(f.storageDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(path.join(f.storageDir, ...versions[0].storageKey.split("/")));
  });
});

describe("paths and storage keys", () => {
  it("file names are metadata only: directories and traversal are stripped", async () => {
    const { documentId } = await makeTextDocument(f.ctx.lawyer, {
      processId,
      fileName: "../../../../etc/passwd.txt",
      text: "conteúdo inofensivo",
    });
    const { documentId: winDoc } = await makeTextDocument(f.ctx.lawyer, {
      processId,
      fileName: "..\\..\\Windows\\System32\\drivers.txt",
      text: "outro conteúdo",
    });
    for (const id of [documentId, winDoc]) {
      const doc = await getDocument(f.ctx.lawyer, id);
      const v = doc.versions[0];
      expect(v.fileName).not.toMatch(/[\\/]/);
      expect(v.fileName).not.toContain("..");
      expect(v.fileName.endsWith(".txt")).toBe(true);
      const [row] = await f.db.select().from(documentVersions).where(eq(documentVersions.id, v.id));
      expect(row.storageKey).toBe(buildStorageKey(f.orgA, id, v.id));
    }
    for (const file of await listFiles(f.storageDir)) {
      expect(path.relative(f.storageDir, file).startsWith("..")).toBe(false);
    }
  });

  it("storage keys that try to escape the root are rejected", async () => {
    const storage = new LocalStorageProvider(f.storageDir);
    for (const key of ["../outside", "../../etc/passwd", "a/../../b", "/etc/passwd", "C:\\Windows\\win.ini", "a//b", "ABC", "..", ""]) {
      expect(() => assertValidStorageKey(key), key).toThrow(InvalidStorageKeyError);
      await expect(storage.put(key, utf8("x")), key).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.getStream(key), key).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.exists(key), key).rejects.toBeInstanceOf(InvalidStorageKeyError);
    }
    expect(() => buildStorageKey(f.orgA, "../../etc", "passwd")).toThrow(InvalidStorageKeyError);
    expect(() => buildStorageKey("..", f.orgA, f.orgA)).toThrow(InvalidStorageKeyError);
  });

  it("a version can only be opened through its own document", async () => {
    const one = await makeTextDocument(f.ctx.lawyer, { processId, text: "primeiro documento" });
    const two = await makeTextDocument(f.ctx.lawyer, { processId, text: "segundo documento" });
    await expect(openDocumentVersion(f.ctx.lawyer, one.documentId, two.versionId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(openDocumentVersion(f.ctx.lawyer, one.documentId, "../../etc/passwd")).rejects.toBeInstanceOf(NotFoundError);
    const opened = await openDocumentVersion(f.ctx.lawyer, one.documentId, one.versionId);
    expect(opened.mimeType).toMatch(/^text\/plain/);
    const content = new TextDecoder().decode(await readStreamToBytes(opened.stream, 1024));
    expect(content).toBe("primeiro documento");
    expect(getStorage()).toBeInstanceOf(LocalStorageProvider);
  });
});
