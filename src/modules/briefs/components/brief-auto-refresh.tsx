"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Refreshes the server-rendered page every few seconds while a preliminary
 * analysis is being generated, so the result appears without a manual reload.
 * Stops after `maxDurationMs` and offers a manual refresh.
 */
export function BriefAutoRefresh({
  active,
  intervalMs = 3000,
  maxDurationMs = 180_000,
  className,
}: {
  active: boolean;
  intervalMs?: number;
  maxDurationMs?: number;
  className?: string;
}) {
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

  if (!active) return null;

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
            A análise preliminar ainda está em processamento. A atualização automática foi pausada; atualize para ver o
            andamento.
          </span>
        ) : (
          <>
            <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin" />
            <span>Gerando a análise preliminar (simulação). Esta área é atualizada automaticamente.</span>
          </>
        )}
      </p>
      {timedOut ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setTimedOut(false);
            setRound((r) => r + 1);
            router.refresh();
          }}
        >
          <RefreshCw aria-hidden="true" />
          Atualizar agora
        </Button>
      ) : null}
    </div>
  );
}
