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

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  legal_manager: PERMISSIONS.filter((p) => p !== "admin:users" && p !== "admin:organization"),
  lawyer: [
    ...READ_ONLY,
    "process:write",
    "occurrence:write",
    "contract:write",
    "document:upload",
    "task:write",
    "deadline:write",
    "deadline:validate",
    "comment:write",
    "alert:resolve",
    "analysis:request",
    "analysis:review",
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
  ],
  // Executives only consult information.
  executive: READ_ONLY,
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
  "admin:organization": "Configurar organização, IA e rotinas",
  "audit:read": "Consultar auditoria",
};

export function can(ctx: Pick<AuthContext, "role" | "kind">, permission: Permission): boolean {
  if (ctx.kind === "system") return true;
  return ROLE_PERMISSIONS[ctx.role].includes(permission);
}

export function assertCan(ctx: Pick<AuthContext, "role" | "kind">, permission: Permission): void {
  if (!can(ctx, permission)) throw new ForbiddenError();
}
