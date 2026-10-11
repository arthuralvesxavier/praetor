"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type AnalysisAutoRefreshProps = {
  /** True while any analysis shown on the page is queued or running. */
  active: boolean;
  intervalMs?: number;
  /** Stops polling after this long (default 3 minutes) to avoid endless refreshes. */
  maxDurationMs?: number;
  className?: string;
};

/**
 * Refreshes the server-rendered page every few seconds while an analysis is
 * pending, so its result appears without a manual reload. Announces the state
 * through an aria-live region.
 */
export function AnalysisAutoRefresh({
  active,
  intervalMs = 4000,
  maxDurationMs = 180_000,
  className,
}: AnalysisAutoRefreshProps) {
  const router = useRouter();
  const [timedOut, setTimedOut] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!active || timedOut) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt >= maxDurationMs) {
        window.clearInterval(timer);
        setTimedOut(true);
        return;
      }
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [active, timedOut, intervalMs, maxDurationMs, router, round]);

  if (!active) {
    return <p role="status" aria-live="polite" className="sr-only" />;
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900",
        className,
      )}
    >
      <p role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-2">
        {timedOut ? (
          <span>
            A análise ainda está em processamento. A atualização automática foi pausada; atualize a página para ver o
            andamento.
          </span>
        ) : (
          <>
            <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
            <span>Análise em processamento. Esta área é atualizada automaticamente.</span>
          </>
        )}
      </p>
      {timedOut ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            router.refresh();
            setTimedOut(false);
            setRound((r) => r + 1);
          }}
        >
          <RefreshCw aria-hidden="true" />
          Atualizar agora
        </Button>
      ) : null}
    </div>
  );
}
