import { and, eq, inArray } from "drizzle-orm";
import type { DocumentCategory } from "@/domain/enums";
import { getDocumentVersionPageText } from "@/modules/documents/service";
import { documentWhere } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import { documents, documentVersions } from "@/server/db/schema";
import { AppError, ValidationError } from "@/server/lib/errors";
import { excerptFoundIn, MIN_EXCERPT_LENGTH } from "./validation";

/**
 * Conferência automática das fontes documentais de um relatório, com o
 * contexto de quem gera: o documento existe e está visível, a versão é do
 * documento e tem o hash lido pelo gerador, a página existe e o trecho
 * literal está no texto daquela página (texto extraído pelo módulo de
 * documentos). Uma fonte não confirmada nunca serve de base de afirmação.
 */

export type DocumentSourceInput = {
  key: string;
  documentId: string;
  documentVersionId: string;
  page: number;
  excerpt: string;
  /** Hash da versão lida pelo gerador: sempre comparado (ausente = fonte não confirmada). */
  expectedSha256: string | null;
};

export type DocumentSourceResult = {
  key: string;
  confirmed: boolean;
  reason: string | null;
  /** Documento visível para quem gera (senão nem o id é gravado no relatório). */
  visible: boolean;
  documentId: string | null;
  documentVersionId: string | null;
  documentTitle: string | null;
  versionNumber: number | null;
  sha256: string | null;
  category: DocumentCategory | null;
  /** PD-04: documento de saúde; só referenciado, nunca transcrito. */
  sensitive: boolean;
  pageCount: number | null;
};

const NOT_VISIBLE = "Documento inexistente, excluído ou fora do acesso de quem gerou o relatório.";

export async function checkDocumentSources(
  ctx: AuthContext,
  inputs: readonly DocumentSourceInput[],
  db: DbOrTx = getDb(),
): Promise<Map<string, DocumentSourceResult>> {
  const results = new Map<string, DocumentSourceResult>();
  if (inputs.length === 0) return results;
  const empty = (input: DocumentSourceInput, reason: string): DocumentSourceResult => ({
    key: input.key,
    confirmed: false,
    reason,
    visible: false,
    documentId: null,
    documentVersionId: null,
    documentTitle: null,
    versionNumber: null,
    sha256: null,
    category: null,
    sensitive: false,
    pageCount: null,
  });
  if (!can(ctx, "document:read")) {
    for (const input of inputs) results.set(input.key, empty(input, "Perfil de quem gerou sem permissão para consultar documentos."));
    return results;
  }

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const versionIds = [...new Set(inputs.map((i) => i.documentVersionId).filter((v) => UUID.test(v)))];
  const rows = versionIds.length
    ? await db
        .select({
          versionId: documentVersions.id,
          documentId: documentVersions.documentId,
          versionNumber: documentVersions.versionNumber,
          sha256: documentVersions.sha256,
          pageCount: documentVersions.pageCount,
          title: documents.title,
          category: documents.category,
        })
        .from(documentVersions)
        .innerJoin(documents, eq(documents.id, documentVersions.documentId))
        .where(
          and(
            inArray(documentVersions.id, versionIds),
            eq(documentVersions.organizationId, ctx.organizationId),
            documentWhere(ctx),
          ),
        )
    : [];
  const meta = new Map(rows.map((r) => [r.versionId, r]));

  for (const input of inputs) {
    const m = meta.get(input.documentVersionId);
    if (!m || m.documentId !== input.documentId) {
      results.set(input.key, empty(input, m ? "A versão citada não pertence ao documento informado." : NOT_VISIBLE));
      continue;
    }
    const base: DocumentSourceResult = {
      key: input.key,
      confirmed: false,
      reason: null,
      visible: true,
      documentId: m.documentId,
      documentVersionId: m.versionId,
      documentTitle: m.title,
      versionNumber: m.versionNumber,
      sha256: m.sha256,
      category: m.category,
      sensitive: m.category === "sensitive_health",
      pageCount: m.pageCount,
    };
    const fail = (reason: string) => results.set(input.key, { ...base, reason });
    if (!input.expectedSha256) {
      fail("Hash da versão lida não informado: o conteúdo citado não pode ser conferido.");
      continue;
    }
    if (input.expectedSha256.toLowerCase() !== m.sha256.toLowerCase()) {
      fail("O conteúdo da versão citada não é o que foi lido (hash diferente).");
      continue;
    }
    if (!Number.isInteger(input.page) || input.page < 1) {
      fail("Página inválida.");
      continue;
    }
    if ((input.excerpt ?? "").replace(/\s+/g, " ").trim().length < MIN_EXCERPT_LENGTH) {
      fail(`Trecho curto demais para conferência (mínimo de ${MIN_EXCERPT_LENGTH} caracteres).`);
      continue;
    }
    try {
      const page = await getDocumentVersionPageText(ctx, input.documentId, input.documentVersionId, input.page);
      if (page.page === null) {
        fail("Documento sem paginação: a página citada não pode ser conferida.");
        continue;
      }
      if (!excerptFoundIn(page.text, input.excerpt)) {
        fail(`Trecho não encontrado na página ${input.page}${page.truncated ? " (texto da página truncado na conferência)" : ""}.`);
        continue;
      }
      results.set(input.key, { ...base, confirmed: true, pageCount: page.pageCount });
    } catch (err) {
      if (err instanceof ValidationError) {
        fail(`Página ${input.page} inexistente neste documento${m.pageCount ? ` (${m.pageCount} páginas)` : ""}.`);
      } else if (err instanceof AppError) {
        fail(err.code === "not_found" ? "Texto do documento indisponível para conferência." : err.message);
      } else {
        throw err;
      }
    }
  }
  return results;
}
