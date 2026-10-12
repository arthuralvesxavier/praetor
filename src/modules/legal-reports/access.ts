import { and, eq, inArray, isNotNull, isNull, notExists, notInArray, or, sql, type SQL } from "drizzle-orm";
import { hasOrganizationWideScope, seesConfidential, visibleDocumentIds, visibleProcessIds } from "@/server/auth/access";
import type { AuthContext } from "@/server/auth/context";
import { can, PERMISSIONS } from "@/server/auth/permissions";
import { getDb } from "@/server/db/client";
import { legalReportItems, legalReports } from "@/server/db/schema/legal-reports";

/**
 * Visibilidade dos relatórios jurídicos (além de `legal_report:read`):
 * - organização do usuário;
 * - relatório de processo: o processo precisa estar visível (`processWhere`);
 * - relatório sem processo (carteira, provisão, responsável): perfis com
 *   escopo da organização inteira, ou quem gerou;
 * - todo documento citado por um item precisa estar visível (como as análises
 *   de IA): quem não vê um documento sensível não vê o relatório que o cita;
 * - quem vê precisa ter as permissões de leitura do conteúdo que o relatório traz
 *   (`parameters.requiredPermissions`, ex.: `brief:read` com itens da análise
 *   preliminar, `deadline:read` com prazos, `contingency:read` com valores): o
 *   relatório gerado pelo sistema não abre esse conteúdo a perfis que não o veem;
 * - documento de teste do motor (`is_sample`): só quem gerou (ele lista
 *   processos visíveis a quem gerou).
 * Administradores e gestores jurídicos veem todos os relatórios da organização.
 */
export function legalReportWhere(ctx: AuthContext): SQL {
  const r = legalReports;
  const base = eq(r.organizationId, ctx.organizationId);
  if (seesConfidential(ctx)) return base;
  const processOk = or(isNull(r.processId), inArray(r.processId, visibleProcessIds(ctx)));
  const mine = ctx.userId ? eq(r.generatedById, ctx.userId) : sql`false`;
  const orgLevelOk = hasOrganizationWideScope(ctx) ? undefined : or(isNotNull(r.processId), mine);
  // O documento de teste do motor lista processos da carteira visíveis a quem o gerou: só quem gerou
  // (e quem vê tudo) o enxerga, para não expor processos que outro perfil não veria.
  const sampleOk = or(eq(r.isSample, false), mine);
  const documentsOk = notExists(
    getDb()
      .select({ one: sql`1` })
      .from(legalReportItems)
      .where(
        and(
          eq(legalReportItems.reportId, r.id),
          isNotNull(legalReportItems.documentId),
          notInArray(legalReportItems.documentId, visibleDocumentIds(ctx)),
        ),
      ),
  );
  const lacking = PERMISSIONS.filter((p) => !can(ctx, p));
  const permissionsOk = lacking.length
    ? sql`not (coalesce(${r.parameters} -> 'requiredPermissions', '[]'::jsonb) ?| array[${sql.join(
        lacking.map((p) => sql`${p}`),
        sql`, `,
      )}]::text[])`
    : undefined;
  return and(base, processOk, orgLevelOk, sampleOk, documentsOk, permissionsOk) ?? base;
}
