import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { AuthContext } from "@/server/auth/context";
import { analysisWhere } from "@/server/auth/access";
import { assertCan } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { aiAnalyses, aiAnalysisSources } from "@/server/db/schema";

/**
 * Private data helpers for the analysis UI (things the analyses service does
 * not expose). Same rules as services: permission check + row-visibility scope.
 */

/** Content-hash prefixes of the sources of a visible analysis, keyed by ref ("S1" -> "3fa9c01b2d4e"). */
export async function loadSourceHashPrefixes(
  ctx: AuthContext,
  analysisId: string,
  length = 12,
): Promise<Map<string, string>> {
  assertCan(ctx, "analysis:read");
  const visible = getDb().select({ id: aiAnalyses.id }).from(aiAnalyses).where(and(eq(aiAnalyses.id, analysisId), analysisWhere(ctx)));
  const rows = await getDb()
    .select({ ref: aiAnalysisSources.ref, contentHash: aiAnalysisSources.contentHash })
    .from(aiAnalysisSources)
    .where(
      and(
        eq(aiAnalysisSources.analysisId, analysisId),
        eq(aiAnalysisSources.organizationId, ctx.organizationId),
        inArray(aiAnalysisSources.analysisId, visible),
      ),
    );
  return new Map(rows.map((r) => [r.ref, r.contentHash.slice(0, length)]));
}
