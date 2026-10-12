import { ArrowRight, ClipboardCheck, ExternalLink, FileText, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import {
  PROCESS_INSTANCE_LABELS,
  TEXT_EXTRACTION_STATUS_LABELS,
  VALUATION_KIND_LABELS,
  VALUATION_SOURCE_LABELS,
  VALUATION_SOURCES,
} from "@/domain/enums";
import { centsToInputValue, formatDate, formatDateTime, formatMoneyCents, formatNumber } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { buildHref, enumParam, hasAnyParam, idParam, pageParam, type SearchParams } from "@/lib/search-params";
import { Delta, EstimateBadge, ValuationStatusBadge } from "@/modules/contingency/components/badges";
import { ReviewActions, ReviewQueueTable, type QueueRow } from "@/modules/contingency/components/review-forms";
import { CONFIDENCE_FILTERS } from "@/modules/contingency/schemas";
import { getReviewItem, listReviewQueue, type ReviewItem } from "@/modules/contingency/service";
import { can } from "@/server/auth/permissions";
import { requirePageContext } from "@/server/auth/session";
import { NotFoundError } from "@/server/lib/errors";

export const metadata: Metadata = { title: "Conferência de valores" };

const FILTER_KEYS = ["origem", "confianca"] as const;

export default async function ReviewQueuePage(props: { searchParams: Promise<SearchParams> }) {
  const ctx = await requirePageContext("contingency:read");
  const sp = await props.searchParams;
  const source = enumParam(sp, "origem", VALUATION_SOURCES);
  const confidence = enumParam(sp, "confianca", CONFIDENCE_FILTERS);
  const itemId = idParam(sp, "item");
  const canApprove = can(ctx, "contingency:approve");

  const queue = await listReviewQueue(ctx, { source, confidence, page: pageParam(sp) });
  let item: ReviewItem | null = null;
  let itemMissing = false;
  if (itemId) {
    try {
      item = await getReviewItem(ctx, itemId);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      itemMissing = true;
    }
  }
  const filtered = hasAnyParam(sp, FILTER_KEYS);
  const nextItem = queue.items.find((i) => i.id !== itemId);

  const rows: QueueRow[] = queue.items.map((i) => ({
    id: i.id,
    href: buildHref("/contingencias/revisao", sp, { item: i.id }),
    selected: i.id === itemId,
    processNumber: i.processNumber,
    processTitle: i.processTitle,
    kindLabel: VALUATION_KIND_LABELS[i.kind],
    amount: formatMoneyCents(i.amountCents),
    currentOfficial: i.currentOfficialCents !== null ? formatMoneyCents(i.currentOfficialCents) : null,
    baseDate: formatDate(i.baseDate),
    sourceLabel: VALUATION_SOURCE_LABELS[i.source],
    isSimulation: i.source === "simulation",
    confidence: i.confidence,
    bulkEligible: i.bulkEligible,
    documentLabel: i.documentTitle ? `${i.documentTitle}${i.page ? ` · p. ${i.page}` : ""}` : null,
  }));

  return (
    <>
      <PageHeader
        title="Conferência de valores"
        description="Valores propostos (planilha, peça dos autos, extração simulada ou lançamento de advogado) só passam a oficiais depois da conferência de uma pessoa identificada (RN-11)."
        breadcrumbs={[{ label: "Contingências", href: "/contingencias" }, { label: "Conferência de valores" }]}
        meta={
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <ClipboardCheck aria-hidden="true" className="size-4" />
            {formatNumber(queue.total)} valor(es) aguardando conferência
          </span>
        }
      />

      {!canApprove ? (
        <Callout tone="info" className="mb-4">
          Você pode acompanhar a fila, mas somente perfis com permissão de conferência (gestão jurídica e contabilidade) aprovam,
          corrigem ou rejeitam valores.
        </Callout>
      ) : null}

      <FilterBar basePath="/contingencias/revisao" search={false} showClear={filtered}>
        <FilterSelect name="origem" label="Origem" options={optionsFromLabels(VALUATION_SOURCE_LABELS)} defaultValue={source} placeholder="Todas" />
        <FilterSelect
          name="confianca"
          label="Confiança"
          options={[
            { value: "alta", label: `Alta (≥ ${queue.threshold}%)` },
            { value: "baixa", label: `Baixa (< ${queue.threshold}% ou não informada)` },
          ]}
          defaultValue={confidence}
          placeholder="Todas"
        />
      </FilterBar>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <section aria-label="Fila de conferência" className="min-w-0">
          <Card className="py-4">
            <ReviewQueueTable rows={rows} canApprove={canApprove} threshold={queue.threshold} />
          </Card>
          <Pagination page={queue.page} pageSize={queue.pageSize} total={queue.total} basePath="/contingencias/revisao" searchParams={sp} />
        </section>

        <section aria-label="Valor em conferência" className="min-w-0">
          {item ? (
            <ReviewDetail item={item} canApprove={canApprove} nextHref={nextItem ? buildHref("/contingencias/revisao", sp, { item: nextItem.id }) : null} />
          ) : (
            <EmptyState
              icon={<FileText />}
              title={itemMissing ? "Valor não encontrado ou sem acesso" : "Selecione um valor da fila"}
              description="O valor proposto aparece aqui ao lado da página do documento de onde foi lido, com o trecho destacado."
            />
          )}
        </section>
      </div>
    </>
  );
}

function ReviewDetail({ item, canApprove, nextHref }: { item: ReviewItem; canApprove: boolean; nextHref: string | null }) {
  const v = item.valuation;
  const doc = item.document;
  return (
    <div className="space-y-4 xl:sticky xl:top-4">
      <Card>
        <CardHeader
          actions={
            nextHref ? (
              <ButtonLink href={nextHref} variant="ghost" size="sm">
                Próximo da fila
                <ArrowRight aria-hidden="true" />
              </ButtonLink>
            ) : null
          }
        >
          <CardTitle className="flex flex-wrap items-center gap-2">
            {VALUATION_KIND_LABELS[v.kind]} de {formatMoneyCents(v.amountCents)}
            <ValuationStatusBadge status={v.status} />
            {v.isEstimate ? <EstimateBadge /> : null}
          </CardTitle>
          <CardDescription>
            <Link href={`/processos/${v.processId}?aba=valores`} className="font-medium text-primary-600 hover:underline">
              {v.processNumber}
            </Link>{" "}
            · {v.processTitle}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {v.source === "simulation" ? (
            <Callout tone="warning" title="Extração simulada (demonstração)">
              Este valor foi proposto por uma extração SIMULADA, gerada apenas para demonstração. Confira no documento antes de
              aprovar; nada é oficial sem a sua conferência.
            </Callout>
          ) : null}
          <DescriptionList
            columns={2}
            items={[
              { label: "Data-base", value: formatDate(v.baseDate) },
              { label: "Instância", value: v.instance ? PROCESS_INSTANCE_LABELS[v.instance] : "Não se aplica" },
              { label: "Origem", value: VALUATION_SOURCE_LABELS[v.source] },
              {
                label: "Confiança da extração",
                value:
                  v.confidence === null
                    ? "Não informada (conferência individual)"
                    : `${v.confidence}% — ${v.bulkEligible ? "permite conferência em lote" : `abaixo de ${item.threshold}%: conferência individual`}`,
              },
              {
                label: "Valor oficial atual do mesmo tipo",
                value: item.currentOfficial ? (
                  <span>
                    {formatMoneyCents(item.currentOfficial.amountCents)}{" "}
                    <span className="text-xs text-muted-foreground">(data-base {formatDate(item.currentOfficial.baseDate)})</span>
                    <span className="block text-xs">
                      Diferença: <Delta cents={v.amountCents - item.currentOfficial.amountCents} />
                    </span>
                  </span>
                ) : (
                  "Nenhum (não apurado)"
                ),
              },
              { label: "Proposto por", value: `${v.createdByName ?? "Sistema / importação"} em ${formatDateTime(v.createdAt)}` },
              v.reason ? { label: "Motivo / observação", value: v.reason, full: true } : null,
              v.reviewNote ? { label: "Nota da conferência", value: v.reviewNote, full: true } : null,
            ]}
          />
          {v.status === "proposed" ? (
            canApprove ? (
              <ReviewActions id={v.id} amountInput={centsToInputValue(v.amountCents)} />
            ) : (
              <p className="text-sm text-muted-foreground">Aguardando conferência por um perfil autorizado.</p>
            )
          ) : (
            <Callout tone="success">Este valor já foi conferido. O histórico completo está na aba “Valores e risco” do processo.</Callout>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader
          actions={
            doc?.visible ? (
              <ButtonLink href={`/documentos/${doc.documentId}`} variant="ghost" size="sm">
                Abrir documento
                <ExternalLink aria-hidden="true" />
              </ButtonLink>
            ) : null
          }
        >
          <CardTitle>Documento de origem</CardTitle>
          <CardDescription>
            {doc
              ? doc.visible
                ? `${doc.title ?? "Documento"}${doc.versionNumber ? ` · versão ${doc.versionNumber}` : ""}${
                    doc.page ? ` · página ${doc.page}${doc.pageCount ? ` de ${doc.pageCount}` : ""}` : ""
                  }`
                : "Documento sem acesso para o seu perfil."
              : "Valor sem documento vinculado (planilha ou lançamento manual)."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!doc ? (
            v.excerpt ? <Excerpt text={v.excerpt} /> : <p className="text-sm text-muted-foreground">Sem trecho de origem.</p>
          ) : !doc.visible ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Lock aria-hidden="true" className="size-4" />O documento é restrito: nem o texto nem o trecho citado são exibidos.
            </p>
          ) : doc.pageText ? (
            <PageText text={doc.pageText} highlight={doc.highlight} truncatedStart={doc.truncatedStart} truncatedEnd={doc.truncatedEnd} excerpt={v.excerpt} />
          ) : (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Texto da página indisponível
                {doc.extractionStatus ? ` (extração de texto: ${TEXT_EXTRACTION_STATUS_LABELS[doc.extractionStatus].toLowerCase()})` : ""}.
              </p>
              {v.excerpt ? <Excerpt text={v.excerpt} /> : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Excerpt({ text }: { text: string }) {
  return (
    <blockquote className="rounded-md border-l-4 border-amber-400 bg-amber-50 px-3 py-2 text-sm text-slate-800">
      <span className="sr-only">Trecho citado: </span>
      {text}
    </blockquote>
  );
}

function PageText({
  text,
  highlight,
  truncatedStart,
  truncatedEnd,
  excerpt,
}: {
  text: string;
  highlight: { start: number; end: number } | null;
  truncatedStart: boolean;
  truncatedEnd: boolean;
  excerpt: string | null;
}) {
  return (
    <div className="space-y-2">
      {excerpt && !highlight ? (
        <Callout tone="warning">O trecho citado não foi localizado literalmente nesta página. Confira com atenção.</Callout>
      ) : null}
      <div
        className="max-h-[32rem] overflow-y-auto rounded-md border border-border bg-white p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-800"
        tabIndex={0}
        aria-label="Texto da página do documento"
      >
        {truncatedStart ? <span className="text-muted-foreground">[…] </span> : null}
        {highlight ? (
          <>
            {text.slice(0, highlight.start)}
            <mark className="rounded-sm bg-amber-200 px-0.5 text-slate-900 ring-1 ring-amber-400">
              <span className="sr-only">Início do trecho citado: </span>
              {text.slice(highlight.start, highlight.end)}
              <span className="sr-only"> (fim do trecho citado)</span>
            </mark>
            {text.slice(highlight.end)}
          </>
        ) : (
          text
        )}
        {truncatedEnd ? <span className="text-muted-foreground"> […]</span> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Texto extraído do arquivo, exibido como dado (não como instrução). O destaque marca o trecho que embasou o valor.
      </p>
    </div>
  );
}
