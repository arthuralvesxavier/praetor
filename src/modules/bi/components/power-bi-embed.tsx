"use client";

import { Loader2, RefreshCw } from "lucide-react";
import type { Embed, models as PbiModels, service as PbiService } from "powerbi-client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

type EmbedResponse = { reportId: string; reportName: string; embedUrl: string; token: string; expiresAt: string };

/** Renews the embed token this long before it expires. */
const RENEW_BEFORE_MS = 3 * 60_000;
/** Without "loaded" or "error" by then, the overlay leaves so Power BI's own screen is visible. */
const LOAD_TIMEOUT_MS = 60_000;
/** `TraceType.Fatal` of powerbi-models. */
const FATAL_LEVEL = 6;
const GENERIC_ERROR = "Não foi possível abrir o painel. Tente novamente.";
const TIMEOUT_ERROR =
  "O Power BI não terminou de abrir o painel. Confira a mensagem exibida no quadro abaixo, tente novamente ou fale com o administrador.";

/** pt-BR text for an embed "error" event; only a short, code-like value from Power BI is shown. */
export function embedErrorText(detail: Partial<PbiModels.IError> | undefined): string {
  const code = [detail?.errorCode, detail?.message].find((v) => typeof v === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(v));
  return (
    "O Power BI não conseguiu abrir o painel" +
    (code ? ` (código ${code})` : "") +
    ". A mensagem do Power BI aparece no quadro abaixo. Tente novamente ou fale com o administrador."
  );
}

async function fetchEmbed(reportId: string): Promise<EmbedResponse> {
  const res = await fetch(`/api/bi/embed-token?report=${encodeURIComponent(reportId)}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = (await res.json().catch(() => null)) as Partial<EmbedResponse> & { error?: unknown };
  if (!res.ok || !body || typeof body.token !== "string" || typeof body.embedUrl !== "string") {
    throw new Error(typeof body?.error === "string" ? body.error : GENERIC_ERROR);
  }
  return body as EmbedResponse;
}

/**
 * Incorpora um relatório do Power BI (somente leitura). O token vem de
 * /api/bi/embed-token, com a identidade do usuário (RLS), e é renovado antes
 * de expirar. A biblioteca powerbi-client é carregada sob demanda, só nesta
 * tela. Use com `key={reportId}` para trocar de relatório.
 */
export function PowerBiEmbed({ reportId, reportName }: { reportId: string; reportName: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let loaded = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loadTimer = setTimeout(() => {
      if (!cancelled && !loaded) {
        setError(TIMEOUT_ERROR);
        setStatus("error");
      }
    }, LOAD_TIMEOUT_MS);
    let svc: PbiService.Service | null = null;
    let report: Embed | null = null;
    let expiresAt = 0;

    const fail = (e: unknown) => {
      clearTimeout(loadTimer);
      if (cancelled) return;
      setError(e instanceof Error && e.message ? e.message : GENERIC_ERROR);
      setStatus("error");
    };

    const renew = async () => {
      try {
        const next = await fetchEmbed(reportId);
        if (cancelled || !report) return;
        await report.setAccessToken(next.token);
        expiresAt = Date.parse(next.expiresAt);
        schedule();
      } catch (e) {
        fail(e);
      }
    };

    function schedule() {
      clearTimeout(timer);
      if (!Number.isFinite(expiresAt)) expiresAt = Date.now() + 15 * 60_000;
      const delay = Math.max(30_000, expiresAt - Date.now() - RENEW_BEFORE_MS);
      timer = setTimeout(() => void renew(), delay);
    }

    const onVisible = () => {
      if (document.visibilityState === "visible" && report && expiresAt - Date.now() < RENEW_BEFORE_MS) void renew();
    };

    void (async () => {
      try {
        const [data, pbi] = await Promise.all([fetchEmbed(reportId), import("powerbi-client")]);
        if (cancelled) return;
        svc = new pbi.service.Service(pbi.factories.hpmFactory, pbi.factories.wpmpFactory, pbi.factories.routerFactory);
        report = svc.embed(container, {
          type: "report",
          id: data.reportId,
          embedUrl: data.embedUrl,
          accessToken: data.token,
          tokenType: pbi.models.TokenType.Embed,
          permissions: pbi.models.Permissions.Read,
          settings: {
            panes: { filters: { visible: false }, pageNavigation: { visible: true } },
            localeSettings: { language: "pt-BR", formatLocale: "pt-BR" },
          },
        });
        report.on("loaded", () => {
          loaded = true;
          clearTimeout(loadTimer);
          if (cancelled) return;
          setError(null);
          setStatus("ready");
        });
        report.on<Partial<PbiModels.IError>>("error", (event) => {
          const detail = event.detail;
          if (detail?.message === "TokenExpired") {
            void renew();
            return;
          }
          // Before "loaded", any error means the report will not open: the overlay
          // leaves (Power BI shows its own message in the frame) and a pt-BR
          // explanation appears. After it, only fatal errors (visual warnings are
          // shown by Power BI itself).
          if (cancelled || (loaded && (detail?.level ?? 0) < FATAL_LEVEL)) return;
          clearTimeout(loadTimer);
          setError(embedErrorText(detail));
          setStatus("error");
        });
        expiresAt = Date.parse(data.expiresAt);
        schedule();
        document.addEventListener("visibilitychange", onVisible);
      } catch (e) {
        fail(e);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(loadTimer);
      document.removeEventListener("visibilitychange", onVisible);
      if (svc) svc.reset(container);
    };
  }, [reportId, attempt]);

  return (
    <div className="flex flex-col gap-3">
      {status === "error" ? (
        <Callout tone="danger" title="O painel não pôde ser exibido">
          <p>{error ?? GENERIC_ERROR}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              setError(null);
              setStatus("loading");
              setAttempt((n) => n + 1);
            }}
          >
            <RefreshCw aria-hidden="true" />
            Tentar novamente
          </Button>
        </Callout>
      ) : null}
      <div className="relative overflow-hidden rounded-lg border border-border bg-surface">
        {status === "loading" ? (
          <div role="status" className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-surface text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Carregando o painel…
          </div>
        ) : null}
        <div
          ref={containerRef}
          role="region"
          aria-label={`Painel ${reportName}`}
          className="h-[70vh] min-h-[420px] w-full [&_iframe]:border-0"
        />
      </div>
    </div>
  );
}
