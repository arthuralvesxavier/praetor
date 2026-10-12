import type { Role } from "@/domain/enums";
import { ForbiddenError } from "@/server/lib/errors";
import type { AuthContext } from "./context";

/**
 * Action-level permissions. Record-level visibility (which rows a user can
 * see) is a separate concern implemented in ./access.ts — both must pass.
 */
export const PERMISSIONS = [
  "dashboard:read",
  "process:read",
  "process:write",
  "process:delete",
  "occurrence:read",
  "occurrence:write",
  "occurrence:delete",
  "contract:read",
  "contract:write",
  "contract:delete",
  "document:read",
  "document:upload",
  "document:delete",
  "task:read",
  "task:write",
  "deadline:read",
  "deadline:write",
  "deadline:validate",
  "comment:write",
  "alert:resolve",
  "analysis:read",
  "analysis:request",
  "analysis:review",
  "admin:users",
  "admin:organization",
  "audit:read",
  // v2
  "contingency:read",
  "contingency:write",
  "contingency:approve",
  "snapshot:close",
  "report:read",
  // Consultar e baixar relatórios jurídicos (PDF) dos processos visíveis (legal-reports/access.ts).
  // Separada de `report:read` (relatórios gerenciais, exportações e Power BI da organização inteira),
  // para o escritório externo ler os relatórios dos processos do próprio escritório e nada além.
  "legal_report:read",
  // Gerar e gerar nova versão de relatórios jurídicos (PDF); o tipo ainda limita os papéis (legal-reports/approvers.ts).
  "report:generate",
  "import:run",
  "intake:manage",
  "distribution:manage",
  "brief:read",
  "brief:review",
  "email:read",
  "email:send",
  "preventive_intel:read",
  "court_sync:run",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: Permission[] = [
  "dashboard:read",
  "process:read",
  "occurrence:read",
  "contract:read",
  "document:read",
  "task:read",
  "deadline:read",
  "analysis:read",
];

const LEGAL_WORK: Permission[] = [
  "process:write",
  "occurrence:write",
  "contract:write",
  "document:upload",
  "task:write",
  "deadline:write",
  "comment:write",
  "alert:resolve",
  "analysis:request",
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  legal_manager: PERMISSIONS.filter((p) => p !== "admin:users" && p !== "admin:organization"),
  lawyer: [
    ...READ_ONLY,
    ...LEGAL_WORK,
    "deadline:validate",
    "analysis:review",
    "contingency:read",
    "contingency:write",
    "report:read",
    "legal_report:read",
    "report:generate",
    "intake:manage",
    "brief:read",
    "brief:review",
    "email:read",
    "email:send",
    "preventive_intel:read",
    "court_sync:run",
  ],
  analyst: [
    ...READ_ONLY,
    "occurrence:write",
    "contract:write",
    "document:upload",
    "task:write",
    "deadline:write",
    "comment:write",
    "analysis:request",
    "contingency:read",
    "report:read",
    "legal_report:read",
    "intake:manage",
    "brief:read",
    "email:read",
    "preventive_intel:read",
    "court_sync:run",
  ],
  // Diretoria: consulta painéis, relatórios e inteligência preventiva.
  executive: [...READ_ONLY, "contingency:read", "report:read", "legal_report:read", "preventive_intel:read"],
  // Contabilidade: valores, garantias, risco, provisão e fechamento mensal (RF-16, TE-06).
  accountant: [
    "dashboard:read",
    "process:read",
    "document:read",
    "contingency:read",
    "contingency:write",
    "contingency:approve",
    "snapshot:close",
    "report:read",
    "legal_report:read",
    "report:generate",
    "comment:write",
  ],
  // Auditoria e compliance: leitura, relatórios e trilha de auditoria (TE-10).
  auditor: [...READ_ONLY, "contingency:read", "report:read", "legal_report:read", "audit:read", "brief:read", "email:read"],
  // Escritório externo: somente a própria carteira (RF-21, TE-09); o escopo de linhas está em access.ts.
  // Relatórios jurídicos: só leitura e download dos processos do escritório (`legal_report:read`), sem
  // `report:read` (relatórios gerenciais e Power BI são da organização inteira) e sem gerar nem aprovar.
  external_counsel: [
    "dashboard:read",
    "process:read",
    "process:write",
    "document:read",
    "document:upload",
    "task:read",
    "task:write",
    "deadline:read",
    "deadline:write",
    "comment:write",
    "contingency:read",
    "contingency:write",
    "brief:read",
    "brief:review",
    "email:read",
    "legal_report:read",
  ],
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  "dashboard:read": "Ver dashboard",
  "process:read": "Consultar processos",
  "process:write": "Cadastrar e editar processos",
  "process:delete": "Excluir processos",
  "occurrence:read": "Consultar ocorrências",
  "occurrence:write": "Cadastrar e editar ocorrências",
  "occurrence:delete": "Excluir ocorrências",
  "contract:read": "Consultar contratos",
  "contract:write": "Cadastrar e editar contratos",
  "contract:delete": "Excluir contratos",
  "document:read": "Consultar documentos",
  "document:upload": "Enviar documentos e novas versões",
  "document:delete": "Excluir documentos",
  "task:read": "Consultar tarefas",
  "task:write": "Criar e atualizar tarefas",
  "deadline:read": "Consultar prazos",
  "deadline:write": "Cadastrar prazos",
  "deadline:validate": "Validar prazos sugeridos pela IA",
  "comment:write": "Comentar",
  "alert:resolve": "Resolver alertas",
  "analysis:read": "Consultar análises de IA",
  "analysis:request": "Solicitar análises de IA",
  "analysis:review": "Revisar análises de IA",
  "admin:users": "Administrar usuários, equipes e unidades",
  "admin:organization": "Configurar organização, empresas, escritórios, parâmetros e rotinas",
  "audit:read": "Consultar auditoria",
  "contingency:read": "Consultar valores, garantias, risco e acordos",
  "contingency:write": "Lançar valores, garantias, risco e acordos",
  "contingency:approve": "Conferir e oficializar valores propostos",
  "snapshot:close": "Fechar competência mensal (provisão)",
  "report:read": "Consultar e exportar relatórios",
  "legal_report:read": "Consultar e baixar relatórios jurídicos (PDF) dos processos visíveis",
  "report:generate": "Gerar relatórios jurídicos (PDF) para revisão",
  "import:run": "Importar planilhas da carteira",
  "intake:manage": "Registrar entrada de processos",
  "distribution:manage": "Configurar distribuição e redistribuir demandas",
  "brief:read": "Consultar análises preliminares",
  "brief:review": "Revisar, editar e aprovar análises preliminares",
  "email:read": "Consultar a central de e-mails (simulados)",
  "email:send": "Gerar envios de e-mail (simulados)",
  "preventive_intel:read": "Consultar a inteligência preventiva",
  "court_sync:run": "Consultar o DataJud (CNJ) e sincronizar processos",
};

export function can(ctx: Pick<AuthContext, "role" | "kind">, permission: Permission): boolean {
  if (ctx.kind === "system") return true;
  return ROLE_PERMISSIONS[ctx.role].includes(permission);
}

export function assertCan(ctx: Pick<AuthContext, "role" | "kind">, permission: Permission): void {
  if (!can(ctx, permission)) throw new ForbiddenError();
}
