import { FlaskConical, Search, Send } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ASSIGNMENT_METHOD_LABELS, LEGAL_AREA_LABELS, PROCESS_INSTANCE_LABELS } from "@/domain/enums";
import { formatMoneyCents } from "@/lib/format";
import type { Option } from "@/lib/options";
import { buildHref, type SearchParams } from "@/lib/search-params";
import type { Tone } from "@/lib/tones";
import { applyDistributionAction, reassignProcessAction } from "../actions";
import type { AssignmentPreview, RuleEvaluation } from "../service";
import { InlineAction } from "./inline-action";
import { ManualAssignForm } from "./manual-assign-form";

export type ProcessSearchHit = { id: string; number: string; title: string; court: string };

function evaluationBadge(e: RuleEvaluation): { label: string; tone: Tone } {
  if (e.selected) return { label: "Aplicada", tone: "success" };
  if (!e.isActive) return { label: "Inativa", tone: "neutral" };
  if (!e.evaluated) return { label: "Não avaliada", tone: "neutral" };
  if (e.matched) return { label: "Ignorada", tone: "warning" };
  return { label: "Não se aplica", tone: "neutral" };
}

/** "Testar regras": choose a process, see how the rules decide, apply or redistribute manually. */
export function RuleTestPanel({
  sp,
  query,
  results,
  preview,
  users,
}: {
  sp: SearchParams;
  query: string | undefined;
  results: ProcessSearchHit[];
  preview: AssignmentPreview | null;
  users: Option[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2">
          <FlaskConical aria-hidden="true" className="size-4 text-primary-600" />
          Testar regras e redistribuir
        </CardTitle>
        <CardDescription>
          Escolha um processo para ver como as regras decidem (nada é gravado até você aplicar). Use também para
          redistribuir manualmente, com motivo registrado.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <form method="get" action="/distribuicao" role="search" aria-label="Buscar processo para testar as regras" className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <input type="hidden" name="aba" value="regras" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Label htmlFor="teste-q" className="text-xs text-muted-foreground">
              Processo (número CNJ, título ou parte)
            </Label>
            <Input id="teste-q" name="teste" type="search" defaultValue={query ?? ""} maxLength={200} autoComplete="off" placeholder="Ex.: 0000123-45.2026.5.10.0801" />
          </div>
          <Button type="submit" variant="secondary">
            <Search aria-hidden="true" />
            Buscar
          </Button>
        </form>

        {query ? (
          results.length === 0 ? (
            <p className="text-sm text-muted-foreground" role="status">
              Nenhum processo visível encontrado para “{query}”.
            </p>
          ) : (
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Selecione o processo:</p>
              <ul className="grid gap-1.5">
                {results.map((r) => {
                  const active = preview?.process.id === r.id;
                  return (
                    <li key={r.id}>
                      <Link
                        href={buildHref("/distribuicao", sp, { aba: "regras", processo: r.id })}
                        aria-current={active ? "true" : undefined}
                        className={`flex flex-col rounded-md border px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:flex-row sm:items-center sm:gap-3 ${
                          active ? "border-primary-400 bg-primary-50/60" : "border-border hover:bg-slate-50"
                        }`}
                      >
                        <span className="font-mono text-xs text-slate-900 tabular-nums">{r.number}</span>
                        <span className="min-w-0 flex-1 truncate text-slate-700">{r.title}</span>
                        <span className="text-xs text-muted-foreground">{r.court}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )
        ) : null}

        {preview ? <PreviewDetails preview={preview} users={users} /> : null}
      </CardContent>
    </Card>
  );
}

function PreviewDetails({ preview, users }: { preview: AssignmentPreview; users: Option[] }) {
  const { process: p, decision, evaluations } = preview;
  return (
    <section aria-label="Resultado do teste" className="grid gap-4 border-t border-border pt-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">
          <Link href={`/processos/${p.id}`} className="font-mono underline-offset-2 hover:underline">
            {p.number}
          </Link>
        </h3>
        <p className="text-sm text-slate-700">{p.title}</p>
      </div>
      <DescriptionList
        columns={3}
        items={[
          { label: "Tribunal", value: p.court },
          { label: "Cidade / UF", value: [p.city, p.state].filter(Boolean).join(" / ") },
          { label: "Área", value: LEGAL_AREA_LABELS[p.area] },
          { label: "Instância", value: p.instance ? PROCESS_INSTANCE_LABELS[p.instance] : null },
          { label: "Classe", value: p.processClass },
          { label: "Empresa", value: p.companyName },
          { label: "Unidade", value: p.unitName },
          { label: "Valor da causa", value: p.claimAmountCents === null ? "Não informado" : formatMoneyCents(p.claimAmountCents) },
          { label: "Responsável atual", value: p.responsibleName ?? "Sem responsável" },
          { label: "Escritório externo", value: p.lawFirmName },
        ]}
      />

      {decision.userId ? (
        <Callout tone="info" title={`Pelas regras, o processo iria para: ${decision.userName}`}>
          <p className="mb-1">
            <Badge tone="primary">{ASSIGNMENT_METHOD_LABELS[decision.method]}</Badge>
          </p>
          <p>{decision.reason}</p>
          {p.responsibleId ? (
            <p className="mt-1 text-xs">
              Este processo já tem responsável ({p.responsibleName ?? "cadastrado"}). Na entrada automática ele seria
              mantido; “Aplicar distribuição” substitui pelo resultado das regras.
            </p>
          ) : null}
        </Callout>
      ) : (
        <Callout tone="warning" title="Nenhum responsável elegível">
          {decision.reason}
        </Callout>
      )}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-slate-900">Avaliação das regras, em ordem</h3>
        <Table aria-label="Avaliação de cada regra para o processo">
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Prioridade</TableHead>
              <TableHead>Regra</TableHead>
              <TableHead>Resultado</TableHead>
              <TableHead>Detalhes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {evaluations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-sm text-muted-foreground">
                  Nenhuma regra cadastrada: vale a distribuição padrão por menor carga.
                </TableCell>
              </TableRow>
            ) : (
              evaluations.map((e) => {
                const b = evaluationBadge(e);
                const details = e.skippedReason
                  ? [e.skippedReason, ...(e.matchedOn.length ? [`Atendeu: ${e.matchedOn.join(", ")}.`] : [])]
                  : e.matched
                    ? [e.matchedOn.length ? `Atendeu: ${e.matchedOn.join(", ")}.` : "Regra sem critérios."]
                    : e.mismatches;
                return (
                  <TableRow key={e.ruleId}>
                    <TableCell className="tabular-nums">{e.priority}</TableCell>
                    <TableCell className="min-w-40">{e.ruleName}</TableCell>
                    <TableCell>
                      <StatusBadge label={b.label} tone={b.tone} />
                    </TableCell>
                    <TableCell className="min-w-64 text-xs text-slate-700">
                      <ul className="grid gap-0.5">
                        {details.map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-border p-4">
          <h3 className="text-sm font-semibold text-slate-900">Aplicar distribuição automática</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Grava o responsável indicado pelas regras (escritório e unidade só quando estiverem vazios). Fica registrado na
            auditoria.
          </p>
          <InlineAction action={applyDistributionAction} hiddenFields={{ processId: p.id }} variant="primary" size="md" pendingLabel="Aplicando…" showSuccess>
            <Send aria-hidden="true" />
            Aplicar distribuição
          </InlineAction>
        </div>
        <div className="rounded-md border border-border p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">Redistribuir manualmente</h3>
          <ManualAssignForm action={reassignProcessAction} hiddenFields={{ processId: p.id }} users={users} submitLabel="Redistribuir" />
        </div>
      </div>
    </section>
  );
}
