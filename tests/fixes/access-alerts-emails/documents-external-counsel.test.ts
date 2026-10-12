/**
 * Regression (review: "External counsel can see, search and download every
 * unlinked internal/confidential document of the organization").
 *
 * access.ts rule 10: external counsel has no organization scope, so a
 * document without any link (process, occurrence, contract) is visible to them
 * only when they uploaded it. Internal users keep the previous behaviour
 * (unlinked documents by confidentiality level).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDocument, listDocuments, openDocumentVersion } from "@/modules/documents/service";
import { visibleDocumentIds } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { NotFoundError } from "@/server/lib/errors";
import { makeProcess, makeTextDocument, runJobs, setupFixture, type Fixture } from "../../helpers/fixtures";

let f: Fixture;
const ids: Record<string, string> = {};

async function sees(read: () => Promise<unknown>): Promise<boolean> {
  try {
    const result = await read();
    const stream = (result as { stream?: ReadableStream<Uint8Array> } | null)?.stream;
    if (stream) await stream.cancel();
    return true;
  } catch (err) {
    if (err instanceof NotFoundError) return false;
    throw err;
  }
}

async function visibleIds(ctx: AuthContext): Promise<string[]> {
  return (await visibleDocumentIds(ctx)).map((r) => r.id);
}

beforeAll(async () => {
  f = await setupFixture("fix-docs-ec");
  const { admin, manager, externalCounsel } = f.ctx;

  const internal = await makeTextDocument(admin, {
    title: "Parecer interno sem vínculo QZX",
    text: "Parecer interno da organização, sem vínculo com registros (texto fictício).",
  });
  ids.unlinkedInternal = internal.documentId;
  ids.unlinkedInternalV1 = internal.versionId;

  const confidential = await makeTextDocument(admin, {
    title: "Estratégia confidencial sem vínculo QZX",
    confidentiality: "confidential",
    text: "Estratégia confidencial da organização, sem vínculo (texto fictício).",
  });
  ids.unlinkedConfidential = confidential.documentId;
  ids.unlinkedConfidentialV1 = confidential.versionId;

  // Document of a process assigned to the external firm: still visible to them.
  ids.firmProcess = await makeProcess(manager, { title: "Processo do escritório (fictício)", lawFirmId: f.lawFirmA });
  const firmDoc = await makeTextDocument(admin, {
    title: "Petição do processo do escritório QZX",
    processId: ids.firmProcess,
    text: "Petição inicial do processo patrocinado pelo escritório (texto fictício).",
  });
  ids.firmDoc = firmDoc.documentId;

  // The external counsel's own unlinked upload.
  const own = await makeTextDocument(externalCounsel, {
    title: "Rascunho do escritório sem vínculo QZX",
    text: "Rascunho enviado pelo escritório externo, sem vínculo (texto fictício).",
  });
  ids.ownUnlinked = own.documentId;
  ids.ownUnlinkedV1 = own.versionId;

  await runJobs();
}, 180_000);

afterAll(async () => {
  await f?.teardown();
});

describe("documentWhere — unlinked documents and external counsel", () => {
  it("external counsel does not list or search the organization's unlinked documents", async () => {
    const { externalCounsel } = f.ctx;
    const result = await listDocuments(externalCounsel, { q: "QZX", pageSize: 100 });
    const listed = result.items.map((d) => d.id);
    expect(listed).not.toContain(ids.unlinkedInternal);
    expect(listed).not.toContain(ids.unlinkedConfidential);
    expect(listed).toContain(ids.firmDoc);
    expect(listed).toContain(ids.ownUnlinked);
    expect(result.total).toBe(2);
  });

  it("external counsel cannot open or download an unlinked internal or confidential document", async () => {
    const { externalCounsel } = f.ctx;
    expect(await sees(() => getDocument(externalCounsel, ids.unlinkedInternal))).toBe(false);
    expect(await sees(() => getDocument(externalCounsel, ids.unlinkedConfidential))).toBe(false);
    expect(await sees(() => openDocumentVersion(externalCounsel, ids.unlinkedInternal, ids.unlinkedInternalV1))).toBe(false);
    expect(
      await sees(() => openDocumentVersion(externalCounsel, ids.unlinkedConfidential, ids.unlinkedConfidentialV1)),
    ).toBe(false);

    const visible = await visibleIds(externalCounsel);
    expect(visible).not.toContain(ids.unlinkedInternal);
    expect(visible).not.toContain(ids.unlinkedConfidential);
    expect(visible).toContain(ids.firmDoc);
  });

  it("the uploader still sees and downloads their own unlinked upload", async () => {
    const { externalCounsel } = f.ctx;
    expect(await sees(() => getDocument(externalCounsel, ids.ownUnlinked))).toBe(true);
    expect(await sees(() => openDocumentVersion(externalCounsel, ids.ownUnlinked, ids.ownUnlinkedV1))).toBe(true);
    expect(await visibleIds(externalCounsel)).toContain(ids.ownUnlinked);
  });

  it("internal roles keep the previous behaviour for unlinked documents", async () => {
    const { lawyer, analyst, executive, admin } = f.ctx;
    // Internal level: every internal reader.
    for (const ctx of [lawyer, analyst, executive, admin]) {
      expect(await sees(() => getDocument(ctx, ids.unlinkedInternal))).toBe(true);
    }
    // Confidential level: lawyers (and admins), not analysts or executives.
    expect(await sees(() => getDocument(lawyer, ids.unlinkedConfidential))).toBe(true);
    expect(await sees(() => getDocument(admin, ids.unlinkedConfidential))).toBe(true);
    expect(await sees(() => getDocument(analyst, ids.unlinkedConfidential))).toBe(false);
    expect(await sees(() => getDocument(executive, ids.unlinkedConfidential))).toBe(false);
  });
});
