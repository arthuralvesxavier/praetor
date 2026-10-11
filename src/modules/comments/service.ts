import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { EntityRef } from "@/domain/entities";
import {
  analysisWhere,
  contractWhere,
  deadlineWhere,
  documentWhere,
  entityReferenceWhere,
  occurrenceWhere,
  processWhere,
  taskWhere,
} from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { assertCan, can, type Permission } from "@/server/auth/permissions";
import { getDb, type DbOrTx } from "@/server/db/client";
import {
  aiAnalyses,
  comments,
  contracts,
  deadlines,
  documents,
  legalProcesses,
  occurrences,
  tasks,
  users,
} from "@/server/db/schema";
import { recordAudit } from "@/server/services/audit";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/lib/errors";

/**
 * Comments on records. Visibility follows the parent entity: reading requires
 * the parent's read permission and row visibility (access.ts builders);
 * writing additionally requires `comment:write`. Authors may delete (soft)
 * their own comments. Comment bodies are never logged or audited.
 */

export type CommentItem = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: Date;
  /** The current user is the author and may delete it. */
  canDelete: boolean;
};

export const COMMENT_ENTITY_TYPES = [
  "legal_process",
  "occurrence",
  "contract",
  "document",
  "task",
  "deadline",
  "analysis",
] as const satisfies readonly EntityRef["type"][];

export const COMMENT_MAX_LENGTH = 5000;

const entitySchema = z.object({
  type: z.enum(COMMENT_ENTITY_TYPES, { error: "Tipo de registro inválido." }),
  id: z.guid({ error: "Registro inválido." }),
});

const bodySchema = z
  .string({ error: "Escreva o comentário." })
  .trim()
  .min(1, "Escreva o comentário.")
  .max(COMMENT_MAX_LENGTH, `O comentário pode ter no máximo ${COMMENT_MAX_LENGTH.toLocaleString("pt-BR")} caracteres.`);

const READ_PERMISSION: Record<EntityRef["type"], Permission> = {
  legal_process: "process:read",
  occurrence: "occurrence:read",
  contract: "contract:read",
  document: "document:read",
  task: "task:read",
  deadline: "deadline:read",
  analysis: "analysis:read",
};

function parseEntity(entity: unknown): EntityRef {
  const r = entitySchema.safeParse(entity);
  // Malformed references can never point to a visible record.
  if (!r.success) throw new NotFoundError();
  return r.data;
}

/** Permission to read the parent + parent visible to ctx; otherwise NotFoundError (existence is not revealed). */
async function assertEntityVisible(ctx: AuthContext, entity: EntityRef, db: DbOrTx = getDb()): Promise<void> {
  assertCan(ctx, READ_PERMISSION[entity.type]);
  let found: { id: string }[];
  switch (entity.type) {
    case "legal_process":
      found = await db
        .select({ id: legalProcesses.id })
        .from(legalProcesses)
        .where(and(eq(legalProcesses.id, entity.id), processWhere(ctx)))
        .limit(1);
      break;
    case "occurrence":
      found = await db
        .select({ id: occurrences.id })
        .from(occurrences)
        .where(and(eq(occurrences.id, entity.id), occurrenceWhere(ctx)))
        .limit(1);
      break;
    case "contract":
      found = await db
        .select({ id: contracts.id })
        .from(contracts)
        .where(and(eq(contracts.id, entity.id), contractWhere(ctx)))
        .limit(1);
      break;
    case "document":
      found = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, entity.id), documentWhere(ctx)))
        .limit(1);
      break;
    case "task":
      found = await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, entity.id), taskWhere(ctx)))
        .limit(1);
      break;
    case "deadline":
      found = await db
        .select({ id: deadlines.id })
        .from(deadlines)
        .where(and(eq(deadlines.id, entity.id), deadlineWhere(ctx)))
        .limit(1);
      break;
    case "analysis":
      found = await db
        .select({ id: aiAnalyses.id })
        .from(aiAnalyses)
        .where(and(eq(aiAnalyses.id, entity.id), analysisWhere(ctx)))
        .limit(1);
      break;
  }
  if (found.length === 0) throw new NotFoundError();
}

export async function listComments(ctx: AuthContext, entity: EntityRef): Promise<CommentItem[]> {
  const ref = parseEntity(entity);
  await assertEntityVisible(ctx, ref);
  const rows = await getDb()
    .select({
      id: comments.id,
      body: comments.body,
      authorId: comments.authorId,
      authorName: users.name,
      createdAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(
      and(
        eq(comments.organizationId, ctx.organizationId),
        eq(comments.entityType, ref.type),
        eq(comments.entityId, ref.id),
        isNull(comments.deletedAt),
        // Redundant with assertEntityVisible, kept as defense in depth.
        entityReferenceWhere(ctx, comments.entityType, comments.entityId),
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(500);
  return rows.map((r) => ({ ...r, canDelete: ctx.userId !== null && r.authorId === ctx.userId }));
}

export async function addComment(ctx: AuthContext, entity: EntityRef, body: string): Promise<{ id: string }> {
  assertCan(ctx, "comment:write");
  const ref = parseEntity(entity);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(undefined, { body: parsed.error.issues.map((i) => i.message) });
  }
  if (!ctx.userId) throw new ForbiddenError("Comentários exigem um usuário autenticado.");
  const authorId = ctx.userId;
  return getDb().transaction(async (tx) => {
    await assertEntityVisible(ctx, ref, tx);
    const [row] = await tx
      .insert(comments)
      .values({ organizationId: ctx.organizationId, entityType: ref.type, entityId: ref.id, authorId, body: parsed.data })
      .returning({ id: comments.id });
    await recordAudit(
      ctx,
      {
        action: "comment.create",
        entityType: ref.type,
        entityId: ref.id,
        // Never the body: comments may hold confidential content.
        summary: "Comentário adicionado",
        metadata: { commentId: row.id },
      },
      tx,
    );
    return { id: row.id };
  });
}

/** Soft delete by the author only. */
export async function deleteComment(ctx: AuthContext, commentId: string): Promise<void> {
  assertCan(ctx, "comment:write");
  const idParsed = z.guid().safeParse(commentId);
  if (!idParsed.success) throw new NotFoundError("Comentário não encontrado.");
  await getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ id: comments.id, authorId: comments.authorId, entityType: comments.entityType, entityId: comments.entityId })
      .from(comments)
      .where(
        and(
          eq(comments.id, idParsed.data),
          eq(comments.organizationId, ctx.organizationId),
          isNull(comments.deletedAt),
          entityReferenceWhere(ctx, comments.entityType, comments.entityId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError("Comentário não encontrado.");
    if (!ctx.userId || row.authorId !== ctx.userId) {
      throw new ForbiddenError("Somente o autor pode excluir este comentário.");
    }
    await tx.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, row.id));
    await recordAudit(
      ctx,
      {
        action: "comment.delete",
        entityType: row.entityType,
        entityId: row.entityId,
        summary: "Comentário excluído pelo autor",
        metadata: { commentId: row.id },
      },
      tx,
    );
  });
}

/** Whether the comment form should be shown for ctx (the parent must already be visible). */
export function canComment(ctx: AuthContext): boolean {
  return can(ctx, "comment:write") && ctx.userId !== null;
}
