import type { Permission } from "@/server/auth/permissions";

/**
 * Groups of the permission matrix (client-safe; type-only permission import).
 * Grouping is derived from the permission prefix ("process:read" -> "process"),
 * so a new permission with a known prefix lands in its area automatically;
 * unknown prefixes go to "Outras permissões" (nothing is ever hidden).
 */
export type PermissionGroup = { key: string; label: string; permissions: Permission[] };

const GROUPS: { key: string; label: string; prefixes: string[] }[] = [
  { key: "painel", label: "Painel e alertas", prefixes: ["dashboard", "alert"] },
  { key: "carteira", label: "Carteira de processos", prefixes: ["process", "court_sync"] },
  {
    key: "entrada",
    label: "Entrada, distribuição e análises preliminares",
    prefixes: ["intake", "distribution", "brief"],
  },
  { key: "contingencias", label: "Contingências, importação e relatórios", prefixes: ["contingency", "snapshot", "import", "report", "legal_report"] },
  { key: "prazos", label: "Prazos e tarefas", prefixes: ["deadline", "task"] },
  { key: "documentos", label: "Documentos e comentários", prefixes: ["document", "comment"] },
  { key: "preventivo", label: "Preventivo e contratos", prefixes: ["occurrence", "contract", "preventive_intel"] },
  { key: "ia", label: "Central de IA", prefixes: ["analysis"] },
  { key: "email", label: "E-mails (simulados)", prefixes: ["email"] },
  { key: "admin", label: "Administração e auditoria", prefixes: ["admin", "audit"] },
];

export function groupPermissions(all: readonly Permission[]): PermissionGroup[] {
  const groups: PermissionGroup[] = GROUPS.map((g) => ({ key: g.key, label: g.label, permissions: [] }));
  const other: PermissionGroup = { key: "outras", label: "Outras permissões", permissions: [] };
  for (const p of all) {
    const prefix = p.split(":")[0];
    const index = GROUPS.findIndex((g) => g.prefixes.includes(prefix));
    (index >= 0 ? groups[index] : other).permissions.push(p);
  }
  return [...groups, other].filter((g) => g.permissions.length > 0);
}
