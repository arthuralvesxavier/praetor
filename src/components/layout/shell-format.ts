/** Pure text helpers for the app header (unit-tested in tests/shell/nav-utils.test.ts). */
import type { AiMode } from "@/domain/enums";
// Type-only import (erased at build time), as in src/lib/nav.ts.
import type { Permission } from "@/server/auth/permissions";

const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

/** "12" / "99+". */
export function formatBadgeCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n > 99 ? "99+" : String(Math.floor(n));
}

/** "1.200" (pt-BR grouping), "0" for invalid or negative input. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return integer.format(Math.floor(n));
}

/** Accessible name of the alerts bell, e.g. "Alertas e pendências: 5 abertos, 2 críticos". */
export function alertsBellLabel(counts: { total: number; critical: number }): string {
  if (counts.total <= 0) return "Alertas e pendências: nenhum alerta aberto";
  const open = counts.total === 1 ? "1 aberto" : `${integer.format(counts.total)} abertos`;
  if (counts.critical <= 0) return `Alertas e pendências: ${open}`;
  const critical = counts.critical === 1 ? "1 crítico" : `${integer.format(counts.critical)} críticos`;
  return `Alertas e pendências: ${open}, ${critical}`;
}

// ---------------------------------------------------------------------------
// "Simulações" header badge
// ---------------------------------------------------------------------------

export type SimulationKey = "case_brief" | "ai" | "email";

export type SimulationItem = {
  key: SimulationKey;
  title: string;
  detail: string;
  /** Screen where the simulation shows up; null when the user cannot open it. */
  link: { href: string; label: string } | null;
};

/** Runtime modes of the simulated providers (ShellData). Null = unknown, nothing is listed. */
export type SimulationModes = {
  caseBriefMode: AiMode | null;
  aiMode: AiMode | null;
  emailMode: "simulated" | "live" | null;
};

type SimulationPermission = Extract<Permission, "brief:read" | "analysis:read" | "email:read">;

/**
 * What the "Simulações" badge lists, in display order. Every running
 * simulation is listed to every user (the runtime mode is not tenant data);
 * only the link depends on the permission to open the related screen. Hiding a
 * link is not authorization: each page checks its own permission.
 */
export function simulationItems(
  modes: SimulationModes,
  allowed: (permission: SimulationPermission) => boolean,
): SimulationItem[] {
  const items: SimulationItem[] = [];
  if (modes.caseBriefMode === "demo") {
    items.push({
      key: "case_brief",
      title: "Análise preliminar simulada",
      detail:
        "Gerada por regras fixas sobre o cadastro e os documentos, sem inteligência artificial. O advogado revisa antes de qualquer uso.",
      link: allowed("brief:read") ? { href: "/analises-preliminares", label: "Abrir análises preliminares" } : null,
    });
  }
  if (modes.aiMode === "demo") {
    items.push({
      key: "ai",
      title: "Central de IA em modo demonstrativo",
      detail:
        "Sem credencial de IA configurada, as análises usam regras simples de demonstração e são identificadas como demonstrativas.",
      link: allowed("analysis:read") ? { href: "/ia", label: "Abrir a Central de IA" } : null,
    });
  }
  if (modes.emailMode === "simulated") {
    items.push({
      key: "email",
      title: "E-mails simulados",
      detail: "Nenhuma mensagem é enviada de verdade. Os e-mails ficam registrados dentro do Praetor.",
      link: allowed("email:read") ? { href: "/emails", label: "Abrir a Central de e-mails" } : null,
    });
  }
  return items;
}
