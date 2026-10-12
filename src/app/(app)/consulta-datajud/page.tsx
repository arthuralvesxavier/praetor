import { Search } from "lucide-react";
import type { Metadata } from "next";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { param } from "@/lib/search-params";
import { CourtRecordView } from "@/modules/court-sync/components/court-record-view";
import { DATAJUD_LIMITS_NOTICE } from "@/modules/court-sync/labels";
import { parseCityState } from "@/modules/court-sync/mapping";
import { lookupCourtRecord, originRecord, type CourtLookupResult } from "@/modules/court-sync/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { aliasLabel } from "@/server/integrations/courts/aliases";
import type { CourtRecord } from "@/server/integrations/courts/types";

export const metadata: Metadata = { title: "Consulta ao DataJud" };

/**
 * Prefill link for "Registrar como processo recebido". Params read by
 * /entrada/nova when it supports prefill: numero, tribunal, vara, cidade, uf,
 * classe, ajuizamento (YYYY-MM-DD). Values come only from the official record.
 */
function intakeHref(number: string, records: CourtRecord[]): string {
  const origin = originRecord(records);
  const place = parseCityState(origin.courtDivision?.name);
  const qs = new URLSearchParams({ numero: number, tribunal: origin.tribunal });
  if (origin.courtDivision?.name) qs.set("vara", origin.courtDivision.name);
  if (place) {
    qs.set("cidade", place.city);
    qs.set("uf", place.state);
  }
  if (origin.processClass?.name) qs.set("classe", origin.processClass.name);
  if (origin.filedAt) qs.set("ajuizamento", origin.filedAt);
  qs.set("origem", "datajud");
  return `/entrada/nova?${qs.toString()}`;
}

export default async function CourtLookupPage(props: PageProps<"/consulta-datajud">) {
  const ctx = await requirePageContext("court_sync:run");
  const sp = await props.searchParams;
  const numero = param(sp, "numero");
  const result: CourtLookupResult | null = numero ? await lookupCourtRecord(ctx, numero) : null;
  const canIntake = can(ctx, "intake:manage");

  return (
    <>
      <PageHeader
        title="Consulta ao DataJud (CNJ)"
        description="Consulte os dados oficiais de um processo pelo número CNJ. Nada é gravado: a consulta só mostra o que o tribunal informou."
        breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Consulta ao DataJud" }]}
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Número do processo</CardTitle>
            <CardDescription>{DATAJUD_LIMITS_NOTICE} A consulta pode levar até um minuto.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action="/consulta-datajud" method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor="numero">Número CNJ</Label>
                <Input
                  id="numero"
                  name="numero"
                  defaultValue={numero ?? ""}
                  placeholder="NNNNNNN-DD.AAAA.J.TR.OOOO"
                  inputMode="numeric"
                  autoComplete="off"
                  required
                />
              </div>
              <Button type="submit">
                <Search aria-hidden="true" />
                Consultar
              </Button>
            </form>
          </CardContent>
        </Card>

        {result ? <LookupResult result={result} canIntake={canIntake} /> : null}
      </div>
    </>
  );
}

function LookupResult({ result, canIntake }: { result: CourtLookupResult; canIntake: boolean }) {
  if (result.status === "inactive") {
    return (
      <Callout tone="warning" title={result.message}>
        Sem a chave pública do CNJ nenhuma consulta é feita. Peça à administração para configurar a variável DATAJUD_API_KEY.
      </Callout>
    );
  }
  if (result.status === "invalid" || result.status === "unsupported") {
    return (
      <Callout tone="info" title="Consulta não disponível para este número">
        {result.message}
      </Callout>
    );
  }
  if (result.status === "error") {
    return (
      <Callout tone="danger" title="Não foi possível consultar agora">
        {result.message} Tente de novo em alguns minutos.
      </Callout>
    );
  }
  if (result.status === "not_found") {
    return (
      <Callout tone="info" title={`Processo ${result.number} não encontrado no DataJud`}>
        Consultados: {result.aliases.map(aliasLabel).join(" e ")}. {result.message}
      </Callout>
    );
  }
  return (
    <section aria-labelledby="resultado-titulo" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="resultado-titulo" className="text-lg font-semibold tracking-tight text-slate-900">
            {result.number}
          </h2>
          <p className="text-sm text-muted-foreground">
            Encontrado em {result.records.length} {result.records.length === 1 ? "grau" : "graus"} (consultados:{" "}
            {result.aliases.map(aliasLabel).join(" e ")}). Dados como informados pelo tribunal, sem alteração.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {result.existingProcess ? (
            <ButtonLink href={`/processos/${result.existingProcess.id}`} variant="outline">
              Abrir o processo na carteira
            </ButtonLink>
          ) : canIntake ? (
            <ButtonLink href={intakeHref(result.number, result.records)}>Registrar como processo recebido</ButtonLink>
          ) : null}
        </div>
      </div>
      {result.message ? (
        <Callout tone="warning" title="Consulta parcial">
          {result.message}
        </Callout>
      ) : null}
      {result.existingProcess ? (
        <Callout tone="info" title="Este número já está na carteira">
          O processo &quot;{result.existingProcess.title}&quot; já está cadastrado. A rotina de acompanhamento importa as movimentações novas
          automaticamente; na ficha do processo também há o botão &quot;Sincronizar agora&quot;.
        </Callout>
      ) : null}
      <CourtRecordView records={result.records} />
    </section>
  );
}
