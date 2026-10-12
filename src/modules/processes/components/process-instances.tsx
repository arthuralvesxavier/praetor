import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { OriginBadge } from "@/components/ui/origin-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PROCESS_INSTANCE_LABELS, PROCESS_PHASE_LABELS } from "@/domain/enums";
import { centsToInputValue, formatMoneyCents } from "@/lib/format";
import { addInstanceAction, removeInstanceAction, updateInstanceAction } from "../actions";
import type { ProcessDetail, ProcessInstanceItem } from "../service";
import { cityWithState } from "../states";
import { PROCESS_SECTION_IDS } from "../tabs";
import { InstanceDialog, type InstanceDefaults } from "./instance-dialog";

const NotInformed = ({ text = "Não informado" }: { text?: string }) => <span className="text-muted-foreground">{text}</span>;

function defaultsFor(i: ProcessInstanceItem): InstanceDefaults {
  return {
    instance: i.instance,
    court: i.court,
    courtDivision: i.courtDivision ?? "",
    city: i.city ?? "",
    state: i.state ?? "",
    processClass: i.processClass ?? "",
    phase: i.phase ?? "",
    phaseDetail: i.phaseDetail ?? "",
    claimAmountCents: centsToInputValue(i.claimAmountCents),
    liquidatedAmountCents: centsToInputValue(i.liquidatedAmountCents),
    isCurrent: i.isCurrent,
  };
}

/** "Instâncias" section of the "Partes e andamento" tab: one link per grau of the same CNJ (RN-01/RN-09). */
export function ProcessInstances({ process: p }: { process: ProcessDetail }) {
  const canEdit = p.permissions.canEdit;
  const cols = canEdit ? 8 : 7;
  const used = new Set(p.instances.map((i) => i.instance));
  const nextInstance = (["first", "second", "superior"] as const).find((i) => !used.has(i)) ?? "";
  const addDefaults: InstanceDefaults = {
    instance: nextInstance,
    court: p.court,
    courtDivision: "",
    city: "",
    state: "",
    processClass: "",
    phase: "",
    phaseDetail: "",
    claimAmountCents: "",
    liquidatedAmountCents: "",
    isCurrent: false,
  };

  return (
    <Card id={PROCESS_SECTION_IDS.instances} aria-labelledby="instancias-titulo" className="scroll-mt-4 pb-0">
      <CardHeader
        actions={
          canEdit && nextInstance ? (
            <InstanceDialog mode="add" action={addInstanceAction} hiddenFields={{ processId: p.id }} defaults={addDefaults} />
          ) : null
        }
      >
        <CardTitle id="instancias-titulo">Instâncias</CardTitle>
        <CardDescription>
          Mesmo número CNJ em cada grau. O processo é contado uma única vez na carteira; os valores de cada instância
          são informativos e não se somam entre si nem com o valor liquidado.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table aria-label="Instâncias do processo">
          <TableHeader>
            <TableRow>
              <TableHead>Grau</TableHead>
              <TableHead>Tribunal / órgão</TableHead>
              <TableHead>Cidade/UF</TableHead>
              <TableHead>Classe</TableHead>
              <TableHead>Fase</TableHead>
              <TableHead className="text-right">Valor da causa</TableHead>
              <TableHead className="text-right">Valor liquidado</TableHead>
              {canEdit ? (
                <TableHead>
                  <span className="sr-only">Ações</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.instances.length === 0 ? (
              <TableEmpty
                colSpan={cols}
                message="Nenhuma instância registrada."
                description={canEdit ? "Use “Incluir instância” para registrar cada grau em que o processo tramitou." : undefined}
              />
            ) : (
              p.instances.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="whitespace-nowrap">
                    <span className="font-medium text-slate-900">{PROCESS_INSTANCE_LABELS[i.instance]}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {i.isCurrent ? <Badge tone="info">Atual</Badge> : null}
                      <OriginBadge origin={i.origin} />
                    </span>
                    {i.origin === "imported" && (i.sourceSheet || i.sourceRow) ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {i.sourceSheet ? `Aba “${i.sourceSheet}”` : "Planilha"}
                        {i.sourceRow ? `, linha ${i.sourceRow}` : ""}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="min-w-36">
                    <span className="block">{i.court}</span>
                    {i.courtDivision ? <span className="block text-xs text-muted-foreground">{i.courtDivision}</span> : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{cityWithState(i.city, i.state) ?? <NotInformed text="Não informada" />}</TableCell>
                  <TableCell className="whitespace-nowrap">{i.processClass ?? <NotInformed text="Não informada" />}</TableCell>
                  <TableCell className="min-w-40">
                    <span className="block">{i.phase ? PROCESS_PHASE_LABELS[i.phase] : <NotInformed text="Não informada" />}</span>
                    {i.phaseDetail ? <span className="block text-xs text-muted-foreground">{i.phaseDetail}</span> : null}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {i.claimAmountCents !== null ? (
                      formatMoneyCents(i.claimAmountCents)
                    ) : i.claimFromRecordCents !== null ? (
                      <>
                        <span className="block">{formatMoneyCents(i.claimFromRecordCents)}</span>
                        <span className="block text-xs font-normal text-muted-foreground">Valor do cadastro do processo</span>
                      </>
                    ) : (
                      <NotInformed />
                    )}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap tabular-nums">
                    {i.liquidatedAmountCents === null ? (
                      <span className="text-muted-foreground">Não apurado</span>
                    ) : (
                      formatMoneyCents(i.liquidatedAmountCents)
                    )}
                  </TableCell>
                  {canEdit ? (
                    <TableCell className="text-right whitespace-nowrap">
                      {/* Stacked: the table fits the page width next to the other columns. */}
                      <div className="flex flex-col items-end gap-1">
                        <InstanceDialog
                          mode="edit"
                          action={updateInstanceAction}
                          hiddenFields={{ instanceId: i.id }}
                          defaults={defaultsFor(i)}
                          instanceLabel={PROCESS_INSTANCE_LABELS[i.instance]}
                          imported={i.origin === "imported"}
                        />
                        {i.removable ? (
                          <ConfirmDialog
                            action={removeInstanceAction}
                            hiddenFields={{ instanceId: i.id }}
                            trigger={
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={`Remover o vínculo ${PROCESS_INSTANCE_LABELS[i.instance]}`}
                              >
                                <Trash2 aria-hidden="true" />
                                Remover
                              </Button>
                            }
                            title="Remover instância?"
                            description={`O vínculo com o ${PROCESS_INSTANCE_LABELS[i.instance]} será removido deste processo. A remoção fica registrada no histórico.`}
                            confirmLabel="Remover"
                            pendingLabel="Removendo…"
                          />
                        ) : null}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
