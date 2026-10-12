import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDemoCaseDocuments } from "@/modules/briefs/demo-documents";
import {
  getDocument,
  getDocumentVersionPageText,
  updateDocumentMetadata,
  uploadDocument,
} from "@/modules/documents/service";
import { documentVersions } from "@/server/db/schema";
import { NotFoundError, ValidationError } from "@/server/lib/errors";
import { makeProcess, runJobs, setupFixture, utf8, type Fixture } from "../helpers/fixtures";

let fx: Fixture;
let processId: string;

beforeAll(async () => {
  fx = await setupFixture("docpages");
  processId = await makeProcess(fx.ctx.admin, { unitId: fx.unitSp, responsibleId: fx.ctx.lawyer.userId, area: "labor" });
});
afterAll(async () => {
  await fx?.teardown();
});

describe("PD-04 health documents", () => {
  it("are always stored as restricted on upload", async () => {
    const { documentId } = await uploadDocument(fx.ctx.analyst, {
      title: "Atestado médico",
      category: "sensitive_health",
      confidentiality: "internal",
      processId,
      file: { name: "atestado.txt", bytes: utf8("Atestado fictício.") },
    });
    const doc = await getDocument(fx.ctx.admin, documentId);
    expect(doc.confidentiality).toBe("restricted");
    // Uploader keeps access; another analyst of the unit does not (rule 12).
    expect((await getDocument(fx.ctx.analyst, documentId)).id).toBe(documentId);
    await expect(getDocument(fx.ctx.executive, documentId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("switching the category to health forces restricted and the level cannot be lowered", async () => {
    const { documentId } = await uploadDocument(fx.ctx.admin, {
      title: "Laudo",
      category: "evidence",
      processId,
      file: { name: "laudo.txt", bytes: utf8("Laudo fictício.") },
    });
    await updateDocumentMetadata(fx.ctx.admin, documentId, { category: "sensitive_health" });
    expect((await getDocument(fx.ctx.admin, documentId)).confidentiality).toBe("restricted");
    await updateDocumentMetadata(fx.ctx.admin, documentId, { confidentiality: "internal" });
    expect((await getDocument(fx.ctx.admin, documentId)).confidentiality).toBe("restricted");
    // Changing the category back allows another level.
    await updateDocumentMetadata(fx.ctx.admin, documentId, { category: "evidence", confidentiality: "internal" });
    expect((await getDocument(fx.ctx.admin, documentId)).confidentiality).toBe("internal");
  });
});

describe("page information", () => {
  it("stores page count and offsets after extraction and serves one page at a time", async () => {
    const [petition] = await buildDemoCaseDocuments({
      number: "0000001-00.2026.5.10.0801",
      court: "TRT10",
      courtDivision: null,
      city: "Palmas",
      state: "TO",
      plaintiff: "Autor Fictício",
      defendant: "Empresa Fictícia",
      processClass: null,
      claimAmountCents: 5_000_000,
      filedAt: "2026-08-01",
    });
    const { documentId, versionId } = await uploadDocument(fx.ctx.admin, {
      title: petition.title,
      category: petition.category,
      processId,
      file: { name: petition.fileName, bytes: petition.bytes },
    });
    await runJobs();
    const [v] = await fx.db.select().from(documentVersions).where(eq(documentVersions.id, versionId));
    expect(v.extractionStatus).toBe("succeeded");
    expect(v.pageCount).toBeGreaterThanOrEqual(3);
    expect(v.pageOffsets).toHaveLength(v.pageCount!);

    const detail = await getDocument(fx.ctx.lawyer, documentId);
    expect(detail.versions[0].pageCount).toBe(v.pageCount);

    const last = await getDocumentVersionPageText(fx.ctx.lawyer, documentId, versionId, v.pageCount!);
    expect(last.text).toContain("DOS PEDIDOS");
    expect(last.page).toBe(v.pageCount);
    await expect(getDocumentVersionPageText(fx.ctx.lawyer, documentId, versionId, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(getDocumentVersionPageText(fx.ctx.adminB, documentId, versionId, 1)).rejects.toBeInstanceOf(NotFoundError);
    // Lawyer of another unit cannot see the process documents.
    await expect(getDocumentVersionPageText(fx.ctx.lawyerRe, documentId, versionId, 1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("non-paged formats return the whole text with page null", async () => {
    const { documentId, versionId } = await uploadDocument(fx.ctx.admin, {
      title: "Nota",
      category: "other",
      processId,
      file: { name: "nota.txt", bytes: utf8("Linha um\nLinha dois") },
    });
    await runJobs();
    const res = await getDocumentVersionPageText(fx.ctx.admin, documentId, versionId, 1);
    expect(res.page).toBeNull();
    expect(res.text).toBe("Linha um\nLinha dois");
  });
});
