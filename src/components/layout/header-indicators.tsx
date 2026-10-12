"use client";

import { AlertTriangle, Bell, ChevronRight, CircleCheck, FileSearch, FlaskConical, Mail, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { HeaderPopover } from "./header-popover";
import {
  alertsBellLabel,
  formatBadgeCount,
  formatCount,
  type SimulationItem,
  type SimulationKey,
} from "./shell-format";

type AlertCounts = { total: number; critical: number };

const iconButton =
  "relative inline-flex size-9 shrink-0 items-center justify-center rounded-md text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 data-[state=open]:bg-slate-100";

const panelRow =
  "group flex items-center gap-2.5 rounded px-2.5 py-2 text-sm text-slate-800 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

const panelLink =
  "inline-flex items-center gap-1 rounded text-sm font-medium text-primary-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// ---------------------------------------------------------------------------
// Alerts bell
// ---------------------------------------------------------------------------

/**
 * Bell of the header. The badge keeps the open count (red with a warning icon
 * when there are critical alerts); the critical count itself is shown inside
 * the panel, with links to /alertas. Counts come from countOpenAlerts(ctx)
 * (row-scoped), so they match the alerts center.
 */
export function AlertsBell({ counts }: { counts: AlertCounts }) {
  const hasCritical = counts.critical > 0;
  return (
    <HeaderPopover
      triggerLabel={alertsBellLabel(counts)}
      triggerClassName={iconButton}
      title="Alertas e pendências"
      trigger={
        <>
          <Bell aria-hidden="true" className="size-5" />
          {counts.total > 0 ? (
            <span
              aria-hidden="true"
              className={cn(
                "absolute -top-0.5 -right-0.5 inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums ring-2 ring-white",
                hasCritical ? "bg-red-700 text-white" : "bg-primary text-white",
              )}
            >
              {hasCritical ? <AlertTriangle className="size-2.5" /> : null}
              {formatBadgeCount(counts.total)}
            </span>
          ) : null}
        </>
      }
    >
      <AlertsPanel counts={counts} />
    </HeaderPopover>
  );
}

/** Content of the bell panel (exported for the static render test). */
export function AlertsPanel({ counts }: { counts: AlertCounts }) {
  return (
    <div className="p-1">
      <p className="px-2.5 pt-2 pb-1 text-sm font-semibold text-slate-900">Alertas e pendências</p>
      {counts.total <= 0 ? (
        <p className="flex items-center gap-2.5 px-2.5 py-2 text-sm text-muted-foreground">
          <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-emerald-600" />
          Nenhum alerta aberto.
        </p>
      ) : (
        <ul>
          <li>
            {counts.critical > 0 ? (
              <Link href="/alertas?severidade=critical" className={panelRow}>
                <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-red-700" />
                <span className="flex-1">{counts.critical === 1 ? "Crítico" : "Críticos"}</span>
                <span className="font-semibold text-red-700 tabular-nums">{formatCount(counts.critical)}</span>
                <ChevronRight aria-hidden="true" className="size-3.5 text-slate-400 group-hover:text-slate-600" />
              </Link>
            ) : (
              <p className="flex items-center gap-2.5 px-2.5 py-2 text-sm text-muted-foreground">
                <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-emerald-600" />
                Nenhum alerta crítico.
              </p>
            )}
          </li>
          <li>
            <Link href="/alertas" className={panelRow}>
              <Bell aria-hidden="true" className="size-4 shrink-0 text-slate-500" />
              <span className="flex-1">{counts.total === 1 ? "Aberto" : "Abertos"}</span>
              <span className="font-semibold text-slate-900 tabular-nums">{formatCount(counts.total)}</span>
              <ChevronRight aria-hidden="true" className="size-3.5 text-slate-400 group-hover:text-slate-600" />
            </Link>
          </li>
        </ul>
      )}
      <div className="mt-1 border-t border-border px-2.5 pt-2 pb-1.5">
        <p className="text-xs text-muted-foreground">Somente alertas dos registros que você pode ver.</p>
        <Link href="/alertas" className={cn(panelLink, "mt-1")}>
          Abrir a central de alertas
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Simulações" badge
// ---------------------------------------------------------------------------

const SIMULATION_ICONS: Record<SimulationKey, ReactNode> = {
  case_brief: <FileSearch />,
  ai: <Sparkles />,
  email: <Mail />,
};

/**
 * One amber "Simulações" badge for everything that is simulated in this
 * environment (items from `simulationItems`), replacing one badge per
 * simulation. Render it only when `items` is not empty.
 */
export function SimulationsMenu({ items, className }: { items: SimulationItem[]; className?: string }) {
  return (
    <HeaderPopover
      triggerLabel="Simulações neste ambiente"
      triggerClassName={cn("inline-flex shrink-0 rounded-full", className)}
      title="Simulações neste ambiente"
      trigger={
        <Badge tone="warning" icon={<FlaskConical />} className="hover:bg-amber-100 max-[359px]:gap-0">
          {/* Below 360 px only the icon fits next to the bell and the user menu; the trigger keeps the name. */}
          <span className="max-[359px]:sr-only">Simulações</span>
        </Badge>
      }
    >
      <SimulationsPanel items={items} />
    </HeaderPopover>
  );
}

/** Content of the "Simulações" panel (exported for the static render test). */
export function SimulationsPanel({ items }: { items: SimulationItem[] }) {
  return (
    <div>
      <div className="px-3.5 pt-3 pb-2">
        <p className="text-sm font-semibold text-slate-900">Simulações neste ambiente</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Estes recursos funcionam em modo de demonstração nesta versão e aparecem identificados em cada tela.
        </p>
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {items.map((item) => (
          <li key={item.key} className="flex gap-2.5 px-3.5 py-2.5">
            <span aria-hidden="true" className="mt-0.5 inline-flex text-amber-700 [&_svg]:size-4 [&_svg]:shrink-0">
              {SIMULATION_ICONS[item.key]}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-900">{item.title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-600">{item.detail}</p>
              {item.link ? (
                <Link href={item.link.href} className={cn(panelLink, "mt-1 text-xs")}>
                  {item.link.label}
                  <ChevronRight aria-hidden="true" className="size-3.5" />
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
