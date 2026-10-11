import type { LucideIcon } from "lucide-react";
import {
  CalendarClock,
  FileSignature,
  FileText,
  LayoutDashboard,
  Scale,
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

/** Main navigation (sidebar). Filter with `can(ctx, perm)` before rendering — hiding is not authorization. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, permissions: ["dashboard:read"] },
  { href: "/processos", label: "Processos", icon: Scale, permissions: ["process:read"] },
  { href: "/preventivo", label: "Jurídico preventivo", icon: ShieldCheck, permissions: ["occurrence:read"] },
  { href: "/contratos", label: "Contratos", icon: FileSignature, permissions: ["contract:read"] },
  { href: "/documentos", label: "Documentos", icon: FileText, permissions: ["document:read"] },
  { href: "/prazos", label: "Prazos e tarefas", icon: CalendarClock, permissions: ["deadline:read"] },
  { href: "/ia", label: "Central de IA", icon: Sparkles, permissions: ["analysis:read"] },
  {
    href: "/admin",
    label: "Administração",
    icon: Settings,
    permissions: ["admin:users", "admin:organization", "audit:read"],
  },
];

/** True when `pathname` is `href` or one of its sub-routes. */
export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
