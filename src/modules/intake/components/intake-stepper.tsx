import { Circle, CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { STAGE_STATE_LABELS, type PipelineStage, type StageKey, type StageState } from "../status";

const ICONS: Record<StageState, ReactNode> = {
  done: <CircleCheck />,
  current: <LoaderCircle />,
  failed: <CircleX />,
  pending: <Circle />,
};

const ICON_CLASSES: Record<StageState, string> = {
  done: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  current: "bg-primary-50 text-primary-700 ring-primary-200",
  failed: "bg-red-50 text-red-700 ring-red-200",
  pending: "bg-slate-50 text-slate-400 ring-slate-200",
};

const STATE_TEXT: Record<StageState, string> = {
  done: "text-emerald-800",
  current: "text-primary-700",
  failed: "text-red-700",
  pending: "text-muted-foreground",
};

/**
 * Visual stepper of the intake pipeline: Recebido → Responsável definido →
 * Leitura dos documentos e análise (simulação) → E-mail ao advogado
 * (simulado) → Revisão → Aprovação. Each stage shows state (text + icon, never
 * color alone), timestamp, actor and detail.
 */
export function IntakeStepper({
  stages,
  links = {},
  animate = false,
}: {
  stages: PipelineStage[];
  links?: Partial<Record<StageKey, { href: string; label: string }>>;
  /** Spin the "current" icon (only while a job is running). */
  animate?: boolean;
}) {
  const doneCount = stages.filter((s) => s.state === "done").length;
  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">
        {doneCount} de {stages.length} etapas concluídas
      </p>
      <ol className="relative grid gap-0">
        {stages.map((stage, index) => {
          const link = links[stage.key];
          const last = index === stages.length - 1;
          return (
            <li key={stage.key} className="relative flex gap-3 pb-5 last:pb-0">
              {!last ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-8 bottom-0 left-[15px] w-px",
                    stage.state === "done" ? "bg-emerald-300" : "bg-border",
                  )}
                />
              ) : null}
              <span
                aria-hidden="true"
                className={cn(
                  "relative z-10 inline-flex size-8 shrink-0 items-center justify-center rounded-full ring-1 [&_svg]:size-4",
                  ICON_CLASSES[stage.state],
                  stage.state === "current" && animate && "[&_svg]:animate-spin",
                )}
              >
                {ICONS[stage.state]}
              </span>
              <div className="min-w-0 flex-1 pt-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h3 className="text-sm font-semibold text-slate-900">
                    <span className="sr-only">Etapa {index + 1}: </span>
                    {stage.label}
                  </h3>
                  <span className={cn("text-xs font-medium", STATE_TEXT[stage.state])}>{STAGE_STATE_LABELS[stage.state]}</span>
                </div>
                {stage.at || stage.actor ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {stage.at ? <time dateTime={stage.at.toISOString()}>{formatDateTime(stage.at)}</time> : null}
                    {stage.at && stage.actor ? " · " : null}
                    {stage.actor ? <span>{stage.actor}</span> : null}
                  </p>
                ) : null}
                {stage.detail ? (
                  <p className={cn("mt-1 text-sm", stage.state === "failed" ? "text-red-800" : "text-slate-700")}>{stage.detail}</p>
                ) : null}
                {link && stage.state !== "pending" ? (
                  <p className="mt-1 text-sm">
                    <Link href={link.href} className="font-medium text-primary-700 underline-offset-2 hover:underline">
                      {link.label}
                    </Link>
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
