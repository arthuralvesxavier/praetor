import { ArrowDown, ArrowUp, Pencil, Plus, Power, PowerOff } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { deleteRuleAction, moveRuleAction, setRuleActiveAction } from "../actions";
import type { RuleListItem } from "../service";
import { InlineAction } from "./inline-action";

/** Rules in evaluation order, with reorder / activate / edit / delete actions. */
export function RulesTable({ rules }: { rules: RuleListItem[] }) {
  return (
    <Table aria-label="Regras de distribuição em ordem de avaliação">
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">Ordem</TableHead>
          <TableHead>Regra</TableHead>
          <TableHead>Quando aplicar</TableHead>
          <TableHead>Distribuição</TableHead>
          <TableHead>Situação</TableHead>
          <TableHead className="text-right">Ações</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.length === 0 ? (
          <TableEmpty
            colSpan={6}
            message="Nenhuma regra de distribuição cadastrada."
            description="Sem regras, cada processo novo vai para o advogado com menor carga da unidade do processo (ou de toda a organização)."
            action={
              <ButtonLink href="/distribuicao/regras/nova" size="sm">
                <Plus aria-hidden="true" />
                Nova regra
              </ButtonLink>
            }
          />
        ) : (
          rules.map((rule, index) => (
            <TableRow key={rule.id}>
              <TableCell className="align-top">
                <div className="flex items-center gap-1">
                  <span className="w-12 text-sm font-semibold text-slate-900 tabular-nums" title="Prioridade">
                    {rule.priority}
                  </span>
                  {index > 0 ? (
                    <InlineAction
                      action={moveRuleAction}
                      hiddenFields={{ id: rule.id, direction: "up" }}
                      variant="ghost"
                      size="icon"
                      buttonClassName="size-7"
                      ariaLabel={`Avaliar “${rule.name}” antes`}
                      pendingLabel=""
                    >
                      <ArrowUp aria-hidden="true" />
                    </InlineAction>
                  ) : null}
                  {index < rules.length - 1 ? (
                    <InlineAction
                      action={moveRuleAction}
                      hiddenFields={{ id: rule.id, direction: "down" }}
                      variant="ghost"
                      size="icon"
                      buttonClassName="size-7"
                      ariaLabel={`Avaliar “${rule.name}” depois`}
                      pendingLabel=""
                    >
                      <ArrowDown aria-hidden="true" />
                    </InlineAction>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="min-w-48 align-top">
                <Link href={`/distribuicao/regras/${rule.id}`} className={tableLinkClasses}>
                  {rule.name}
                </Link>
                {rule.description ? <p className="mt-0.5 text-xs text-muted-foreground">{rule.description}</p> : null}
              </TableCell>
              <TableCell className="min-w-56 align-top">
                {rule.criteriaSummary.length === 0 ? (
                  <span className="text-sm text-muted-foreground">Qualquer processo</span>
                ) : (
                  <ul className="flex flex-wrap gap-1">
                    {rule.criteriaSummary.map((c) => (
                      <li key={c}>
                        <Badge tone="neutral">{c}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>
              <TableCell className="min-w-56 align-top text-sm">
                <p className="font-medium text-slate-900">{rule.methodLabel}</p>
                <p className="text-xs text-slate-700">
                  {rule.assignees.map((a, i) => (
                    <span key={a.id}>
                      {i > 0 ? ", " : ""}
                      <span className={a.available ? undefined : "text-muted-foreground line-through"}>{a.name}</span>
                      {a.available ? null : <span className="sr-only"> (inativo ou sem perfil para receber)</span>}
                    </span>
                  ))}
                </p>
                {rule.nextInRotation ? (
                  <p className="text-xs text-muted-foreground">Próximo do rodízio: {rule.nextInRotation}</p>
                ) : null}
                {rule.lawFirmName ? <p className="text-xs text-muted-foreground">Escritório: {rule.lawFirmName}</p> : null}
                {rule.assignUnitName ? <p className="text-xs text-muted-foreground">Unidade: {rule.assignUnitName}</p> : null}
              </TableCell>
              <TableCell className="align-top">
                <StatusBadge label={rule.isActive ? "Ativa" : "Inativa"} tone={rule.isActive ? "success" : "neutral"} />
              </TableCell>
              <TableCell className="align-top">
                <div className="flex flex-wrap items-start justify-end gap-1.5">
                  <ButtonLink href={`/distribuicao/regras/${rule.id}`} variant="outline" size="sm">
                    <Pencil aria-hidden="true" />
                    Editar
                  </ButtonLink>
                  <InlineAction
                    action={setRuleActiveAction}
                    hiddenFields={{ id: rule.id, active: rule.isActive ? "0" : "1" }}
                    pendingLabel={rule.isActive ? "Desativando…" : "Ativando…"}
                  >
                    {rule.isActive ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}
                    {rule.isActive ? "Desativar" : "Ativar"}
                  </InlineAction>
                  <ConfirmDialog
                    action={deleteRuleAction}
                    hiddenFields={{ id: rule.id }}
                    triggerLabel="Excluir"
                    triggerSize="sm"
                    title={`Excluir a regra “${rule.name}”?`}
                    description="As entradas já distribuídas por ela mantêm o motivo registrado. Para suspender a regra sem perdê-la, use “Desativar”."
                    confirmLabel="Excluir regra"
                    pendingLabel="Excluindo…"
                  />
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
