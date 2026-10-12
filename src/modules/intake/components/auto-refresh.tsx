"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Refreshes the server-rendered page while the pipeline is running (a job for
 * the intake is queued/running). Stops by itself after `maxRefreshes`.
 */
export function AutoRefresh({
  active,
  intervalMs = 3000,
  maxRefreshes = 60,
}: {
  active: boolean;
  intervalMs?: number;
  maxRefreshes?: number;
}) {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const running = active && count < maxRefreshes;

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      setCount((c) => c + 1);
      router.refresh();
    }, intervalMs);
    return () => window.clearTimeout(timer);
  }, [running, count, intervalMs, router]);

  if (!active) return null;
  return (
    <p role="status" aria-live="polite" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {running ? (
        <>
          <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
          Processamento em andamento. Esta página se atualiza sozinha.
        </>
      ) : (
        <>O processamento está demorando. Recarregue a página para ver o andamento.</>
      )}
    </p>
  );
}
