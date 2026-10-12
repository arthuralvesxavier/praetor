import type { LucideIcon } from "lucide-react";
import {
  BellRing,
  CalendarClock,
  ChartColumn,
  ChartPie,
  FileCheck,
  FileSearch,
  FileSignature,
  FileSpreadsheet,
  FileText,
  Gavel,
  Handshake,
  Inbox,
  Landmark,
  LayoutDashboard,
  Lightbulb,
  Mail,
  Route,
  Scale,
  ScanSearch,
  Settings,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
// Type-only import (erased at build time): keeps nav permissions in sync with the server list.
import type { Permission } from "@/server/auth/permissions";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown when the user has ANY of these permissions. */
  permissions: readonly Permission[];
};

export type NavGroup = {
  /** Section title in the sidebar; null = no title. */
  label: string | null;
  items: readonly NavItem[];
};

/**
 * Main navigation (sidebar), grouped by area. Filter each item with
 * `can(ctx, perm)` before rendering — hiding is not authorization (every page
 * calls requirePageContext). Empty groups are not rendered.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: null,
    items: [
      { href: "/dashboard", label: "Painel executivo", icon: LayoutDashboard, permissions: ["dashboard:read"] },
      { href: "/alertas", label: "Alertas e pendências", icon: BellRing, permissions: ["dashboard:read"] },
    ],
  },
  {
    label: "Contencioso",
    items: [
      { href: "/processos", label: "Carteira de processos", icon: Scale, permissions: ["process:read"] },
      { href: "/entrada", label: "Entrada de processos", icon: Inbox, permissions: ["intake:manage", "distribution:manage"] },
      { href: "/analises-preliminares", label: "Análises preliminares", icon: FileSearch, permissions: ["brief:read"] },
      { href: "/audiencias", label: "Audiências", icon: Gavel, permissions: ["process:read"] },
      { href: "/prazos", label: "Prazos e tarefas", icon: CalendarClock, permissions: ["deadline:read", "task:read"] },
      { href: "/consulta-datajud", label: "Consulta ao DataJud", icon: ScanSearch, permissions: ["court_sync:run"] },
    ],
  },
  {
    label: "Contingências",
    items: [
      { href: "/contingencias", label: "Valores e provisão", icon: Landmark, permissions: ["contingency:read"] },
      { href: "/acordos", label: "Acordos", icon: Handshake, permissions: ["contingency:read"] },
      { href: "/relatorios", label: "Relatórios", icon: ChartColumn, permissions: ["report:read"] },
      { href: "/relatorios-juridicos", label: "Relatórios jurídicos (PDF)", icon: FileCheck, permissions: ["report:read"] },
      { href: "/paineis-bi", label: "Painéis Power BI", icon: ChartPie, permissions: ["report:read"] },
    ],
  },
  {
    label: "Preventivo e contratos",
    items: [
      { href: "/preventivo", label: "Ocorrências preventivas", icon: ShieldCheck, permissions: ["occurrence:read"] },
      {
        href: "/inteligencia-preventiva",
        label: "Inteligência preventiva",
        icon: Lightbulb,
        permissions: ["preventive_intel:read"],
      },
      { href: "/contratos", label: "Contratos", icon: FileSignature, permissions: ["contract:read"] },
      { href: "/documentos", label: "Documentos", icon: FileText, permissions: ["document:read"] },
    ],
  },
  {
    label: "Operação",
    items: [
      { href: "/distribuicao", label: "Distribuição", icon: Route, permissions: ["distribution:manage"] },
      { href: "/emails", label: "Central de e-mails", icon: Mail, permissions: ["email:read"] },
      { href: "/importacoes", label: "Importação de planilhas", icon: FileSpreadsheet, permissions: ["import:run"] },
      { href: "/ia", label: "Central de IA", icon: Sparkles, permissions: ["analysis:read"] },
      {
        href: "/admin",
        label: "Administração",
        icon: Settings,
        permissions: ["admin:users", "admin:organization", "audit:read"],
      },
    ],
  },
];

/** Flat list (kept for callers that do not render groups). */
export const NAV_ITEMS: readonly NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** True when `pathname` is `href` or one of its sub-routes. */
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
