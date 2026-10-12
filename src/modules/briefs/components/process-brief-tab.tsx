import { ArrowRight, FileSearch } from "lucide-react";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { formatDateTime, pluralize } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { NotFoundError } from "@/server/lib/errors";
import { getCaseBrief, isStuckGenerating, listCaseBriefs, type CaseBriefDetail } from "../service";
import { BriefAutoRefresh } from "./brief-auto-refresh";
import { BriefStatusBadge, SimulationBadge } from "./brief-badges";
import { RequestBriefButton } from "./brief-actions";
import { BriefNotices } from "./brief-notices";

/**
 * "Análise preliminar" tab of the process page (`/processos/<id>?aba=analise-preliminar`):
 * latest brief, its versions and the button to generate a new one (simulation).
 */
export async function ProcessBriefTab({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  if (!can(ctx, "brief:read")) {
    return <p className="text-sm text-muted-foreground">Seu perfil não tem acesso às análises preliminares.</p>;
  }
  const list = await listCaseBriefs(ctx, { processId, pageSize: 20 });
  const canRequest = can(ctx, "brief:review") || can(ctx, "intake:manage");
  const latestItem = list.items[0] ?? null;
  let latest: CaseBriefDetail | null = null;
  if (latestItem) {
    try {
      latest = await getCaseBrief(ctx, latestItem.id);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  const generating = latest?.status === "generating" && !isStuckGenerating(latest.createdAt);

  if (!latest) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4">
          <EmptyState
            icon={<FileSearch />}
            title="Nenhuma análise preliminar"
            description="A análise preliminar organiza fatos, pedidos, valores, contradições, documentos faltantes e possíveis prazos a partir do cadastro e dos documentos com texto do processo. Nesta versão ela é uma simulação por regras, sem inteligência artificial."
            action={canRequest ? <RequestBriefButton processId={processId} label="Gerar análise preliminar (simulação)" /> : null}
          />
          {!canRequest ? (
            <p className="text-center text-xs text-muted-foreground">Seu perfil pode consultar, mas não solicitar análises preliminares.</p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const c = latest.content;
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <BriefStatusBadge status={latest.status} />
              <SimulationBadge mode={latest.mode} />
            </div>
          }
        >
          <CardTitle>Análise preliminar — versão {latest.version}</CardTitle>
          <CardDescription>
            {latest.generatedAt ? `Gerada em ${formatDateTime(latest.generatedAt)}` : `Solicitada em ${formatDateTime(latest.createdAt)}`}
            {latest.requestedByName ? ` por ${latest.requestedByName}` : ""}
            {latest.currentRevision > 1 ? ` · revisão ${latest.currentRevision}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <BriefNotices mode={latest.mode} systemNotices={c?.systemNotices} compact />
          <BriefAutoRefresh active={generating} />
          {latest.status === "generating" && !generating ? (
            <Callout tone="warning" title="Geração sem resposta">
              A geração desta análise não terminou no tempo esperado. Gere uma nova versão para tentar novamente.
            </Callout>
          ) : null}
          {latest.status === "failed" ? (
            <Callout tone="danger" title="Não foi possível gerar a análise">
              {latest.errorMessage ?? "Falha na geração."}
            </Callout>
          ) : null}
          {latest.isStale ? (
            <Callout tone="warning" title="Análise possivelmente desatualizada">
              {latest.staleReason ?? "Houve mudanças no processo depois da geração."} Gere uma nova versão para considerar as
              informações atuais.
            </Callout>
          ) : null}
          {c ? (
            <>
              <p className="text-sm leading-relaxed">{c.headline}</p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: "Pedidos", value: c.claims.length },
                  { label: "Contradições", value: c.contradictions.length },
                  { label: "Documentos faltantes", value: c.missingDocuments.length },
                  { label: "Urgências", value: c.urgencies.length },
                ].map((s) => (
                  <div key={s.label} className="rounded-md border border-border bg-surface-muted px-3 py-2">
                    <dt className="text-xs text-muted-foreground">{s.label}</dt>
                    <dd className="text-lg font-semibold tabular-nums">{s.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}
          <div className="flex flex-wrap items-start gap-3">
            <ButtonLink href={`/analises-preliminares/${latest.id}`} variant={c ? "primary" : "outline"}>
              Abrir análise completa
              <ArrowRight aria-hidden="true" />
            </ButtonLink>
            {canRequest && !generating ? (
              <RequestBriefButton processId={processId} label="Gerar nova versão (simulação)" />
            ) : null}
          </div>
        </CardContent>
      </Card>

      {list.items.length > 1 ? (
        <Card className="py-0">
          <CardHeader className="pt-5">
            <CardTitle as="h3">Versões anteriores</CardTitle>
            <CardDescription>{pluralize(list.total, "versão", "versões")} desta análise. Cada versão mantém o próprio histórico de revisões.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table aria-label="Versões da análise preliminar">
              <TableHeader>
                <TableRow>
                  <TableHead>Versão</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Gerada em</TableHead>
                  <TableHead className="text-right">Revisão</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((b) => (
                  <TableRow key={b.id} interactive>
                    <TableCell>
                      <Link href={`/analises-preliminares/${b.id}`} className={tableLinkClasses}>
                        Versão {b.version}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <BriefStatusBadge status={b.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{b.generatedAt ? formatDateTime(b.generatedAt) : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.currentRevision || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
