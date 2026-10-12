"use client";

import { PlugZap } from "lucide-react";
import { FormMessage } from "@/components/ui/form-message";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FormState } from "@/lib/form";
import { PendingButton, useAdminForm, type FormAction } from "@/modules/admin/components/form-utils";

type Found = { reports: { id: string; name: string; datasetId: string | null }[] };

/** "Testar conexão": lists the workspace reports (names and ids) so the admin can copy them. */
export function BiConnectionTest<S extends FormState>({ action }: { action: FormAction<S> }) {
  const { state, formAction, pending, onSubmit } = useAdminForm(action);
  const found = state && state.ok ? (state as { data?: Found }).data?.reports : undefined;
  return (
    <div className="flex flex-col gap-3">
      <form action={formAction} onSubmit={onSubmit}>
        <PendingButton pending={pending} pendingLabel="Testando…" variant="outline" size="sm">
          <PlugZap aria-hidden="true" />
          Testar conexão
        </PendingButton>
      </form>
      <FormMessage state={state} />
      {found && found.length > 0 ? (
        <Table aria-label="Relatórios encontrados no workspace">
          <TableHeader>
            <TableRow>
              <TableHead>Relatório</TableHead>
              <TableHead>Id do relatório</TableHead>
              <TableHead>Id do conjunto de dados</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {found.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium text-slate-900">{r.name}</TableCell>
                <TableCell>
                  <code className="text-xs break-all">{r.id}</code>
                </TableCell>
                <TableCell>
                  {r.datasetId ? <code className="text-xs break-all">{r.datasetId}</code> : <span className="text-muted-foreground">Não informado</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}
