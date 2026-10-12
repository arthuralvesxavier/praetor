import type { Permission } from "@/server/auth/permissions";

/**
 * Sections of the administration area (client-safe; type-only permission import).
 * A section is listed when the user has ANY of its permissions; each page
 * still checks its own permission on the server.
 */
export type AdminSectionKey =
  | "visao-geral"
  | "usuarios"
  | "equipes"
  | "unidades"
  | "empresas"
  | "escritorios"
  | "permissoes"
  | "auditoria"
  | "configuracoes"
  | "integracoes";

export type AdminSection = {
  key: AdminSectionKey;
  label: string;
  href: string;
  description: string;
  permissions: readonly Permission[];
};

/** Any of these grants access to the administration area. */
export const ADMIN_AREA_PERMISSIONS: readonly Permission[] = ["admin:users", "admin:organization", "audit:read"];

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    key: "visao-geral",
    label: "Visão geral",
    href: "/admin",
    description: "Resumo da administração.",
    permissions: ADMIN_AREA_PERMISSIONS,
  },
  {
    key: "usuarios",
    label: "Usuários",
    href: "/admin/usuarios",
    description: "Cadastro de usuários, perfis, unidades e redefinição de senha.",
    permissions: ["admin:users"],
  },
  {
    key: "equipes",
    label: "Equipes",
    href: "/admin/equipes",
    description: "Equipes de trabalho, líderes e membros.",
    permissions: ["admin:users"],
  },
  {
    key: "unidades",
    label: "Unidades",
    href: "/admin/unidades",
    description: "Unidades (matriz e filiais) que delimitam a visibilidade dos registros.",
    permissions: ["admin:users"],
  },
  {
    key: "empresas",
    label: "Empresas",
    href: "/admin/empresas",
    description: "Empresas do grupo atendidas pelo jurídico (filtros de carteira, relatórios e indicadores).",
    permissions: ["admin:organization"],
  },
  {
    key: "escritorios",
    label: "Escritórios externos",
    href: "/admin/escritorios",
    description: "Escritórios que patrocinam processos; seus usuários veem apenas a carteira atribuída.",
    permissions: ["admin:organization"],
  },
  {
    key: "permissoes",
    label: "Permissões",
    href: "/admin/permissoes",
    description: "Matriz de permissões por perfil e regras de visibilidade.",
    permissions: ADMIN_AREA_PERMISSIONS,
  },
  {
    key: "auditoria",
    label: "Auditoria",
    href: "/admin/auditoria",
    description: "Trilha de auditoria das ações relevantes.",
    permissions: ["audit:read"],
  },
  {
    key: "configuracoes",
    label: "Configurações",
    href: "/admin/configuracoes",
    description: "Organização, IA, alertas, contingências, e-mail (simulado), entrada de processos, rotinas e retenção.",
    permissions: ["admin:organization"],
  },
  {
    key: "integracoes",
    label: "Integrações",
    href: "/admin/integracoes",
    description: "Situação de cada integração (o que é real, simulado ou não integrado) e saúde das rotinas e da fila.",
    permissions: ["admin:organization"],
  },
];
