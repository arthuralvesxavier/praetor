import type { LegalReportStatus, LegalReportType, Role } from "@/domain/enums";
import { can } from "@/server/auth/permissions";

/**
 * Quem aprova cada tipo de relatório (pessoa identificada; o sistema nunca aprova):
 * - R1 (processo) e R4 (responsável): gestor jurídico ou o advogado responsável do escopo;
 * - R2 (provisão): gestor jurídico ou contabilidade;
 * - R3 (carteira): gestor jurídico.
 * O administrador sempre pode aprovar.
 */
export const APPROVER_RULES: Record<LegalReportType, { roles: readonly Role[]; scopeResponsibleLawyer: boolean; description: string }> = {
  process_report: {
    roles: ["admin", "legal_manager"],
    scopeResponsibleLawyer: true,
    description: "gestor jurídico ou advogado responsável pelo processo",
  },
  provision_report: {
    roles: ["admin", "legal_manager", "accountant"],
    scopeResponsibleLawyer: false,
    description: "gestor jurídico ou contabilidade",
  },
  portfolio_report: {
    roles: ["admin", "legal_manager"],
    scopeResponsibleLawyer: false,
    description: "gestor jurídico",
  },
  responsibility_report: {
    roles: ["admin", "legal_manager"],
    scopeResponsibleLawyer: true,
    description: "gestor jurídico ou advogado responsável do escopo",
  },
};

/**
 * Quem GERA (e gera nova versão de) cada tipo: além da permissão `report:generate`,
 * só os papéis de quem trabalha o tipo. Perfis de leitura (diretoria, auditoria,
 * analista) nunca geram: gerar consome a numeração oficial e cria versão nova.
 * - R1 e R4: gestor jurídico ou advogado (a aprovação continua com o responsável);
 * - R2: gestor jurídico ou contabilidade;
 * - R3: gestor jurídico.
 * O sistema (rotinas) pode gerar; nunca aprova nem substitui versão aprovada.
 */
export const GENERATOR_ROLES: Record<LegalReportType, readonly Role[]> = {
  process_report: ["admin", "legal_manager", "lawyer"],
  provision_report: ["admin", "legal_manager", "accountant"],
  portfolio_report: ["admin", "legal_manager"],
  responsibility_report: ["admin", "legal_manager", "lawyer"],
};

export type ApproverContext = { kind: "user" | "system"; userId: string | null; role: Role };

/**
 * `scopeResponsibleId`: responsável do escopo no momento da aprovação (R1: o
 * responsável atual do processo; R4: o responsável do escopo).
 */
export function canApproveLegalReport(
  ctx: ApproverContext,
  report: { type: LegalReportType; scopeResponsibleId: string | null },
): boolean {
  if (ctx.kind !== "user" || !ctx.userId) return false;
  const rule = APPROVER_RULES[report.type];
  if (rule.roles.includes(ctx.role)) return true;
  return rule.scopeResponsibleLawyer && ctx.role === "lawyer" && report.scopeResponsibleId === ctx.userId;
}

/** Pode gerar um relatório do tipo (permissão `report:generate` + papel do tipo; sistema sempre). */
export function canGenerateLegalReport(ctx: ApproverContext, type: LegalReportType): boolean {
  if (ctx.kind === "system") return true;
  if (!ctx.userId || !can(ctx, "report:generate")) return false;
  return GENERATOR_ROLES[type].includes(ctx.role);
}

/**
 * Pode gerar a versão seguinte de um relatório. Substituir uma versão APROVADA
 * tira de vigor a versão oficial: exige, além de poder gerar o tipo, quem
 * poderia aprovar o relatório (o sistema não substitui versão aprovada).
 */
export function canSupersedeLegalReport(
  ctx: ApproverContext,
  report: { type: LegalReportType; status: LegalReportStatus; scopeResponsibleId: string | null },
): boolean {
  if (report.status === "superseded") return false;
  if (!canGenerateLegalReport(ctx, report.type)) return false;
  if (report.status === "approved") return canApproveLegalReport(ctx, report);
  return true;
}
