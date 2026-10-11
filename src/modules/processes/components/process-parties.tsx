import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PARTY_ROLE_LABELS } from "@/domain/enums";
import { maskDocument } from "@/lib/format";
import { addPartyAction, removePartyAction, updatePartyAction } from "../actions";
import type { ProcessDetail } from "../service";
import { PartyDialog } from "./party-dialog";

export function ProcessParties({ process: p }: { process: ProcessDetail }) {
  const canEdit = p.permissions.canEdit;
  const cols = canEdit ? 5 : 4;
  return (
    <Card className="pb-0">
      <CardHeader
        actions={canEdit ? <PartyDialog mode="add" action={addPartyAction} hiddenFields={{ processId: p.id }} /> : null}
      >
        <CardTitle>Partes</CardTitle>
        <CardDescription>Polos do processo. CPF/CNPJ aparecem mascarados nesta lista.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        <Table aria-label="Partes do processo">
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Polo</TableHead>
              <TableHead>CPF / CNPJ</TableHead>
              <TableHead>Advogado(a)</TableHead>
              {canEdit ? (
                <TableHead>
                  <span className="sr-only">Ações</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.parties.length === 0 ? (
              <TableEmpty
                colSpan={cols}
                message="Nenhuma parte cadastrada."
                description={canEdit ? "Use “Adicionar parte” para registrar os polos do processo." : undefined}
              />
            ) : (
              p.parties.map((party) => (
                <TableRow key={party.id}>
                  <TableCell>
                    <span className="font-medium text-slate-900">{party.name}</span>
                    {party.isClient ? (
                      <Badge tone="primary" className="ml-2">
                        Cliente
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>{PARTY_ROLE_LABELS[party.role]}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">{maskDocument(party.documentNumber)}</TableCell>
                  <TableCell>{party.counselName ?? "—"}</TableCell>
                  {canEdit ? (
                    <TableCell className="text-right whitespace-nowrap">
                      <PartyDialog
                        mode="edit"
                        action={updatePartyAction}
                        hiddenFields={{ partyId: party.id }}
                        partyName={party.name}
                        defaults={{
                          name: party.name,
                          role: party.role,
                          documentNumber: party.documentNumber,
                          isClient: party.isClient,
                          counselName: party.counselName,
                        }}
                      />
                      <ConfirmDialog
                        action={removePartyAction}
                        hiddenFields={{ partyId: party.id }}
                        trigger={
                          <Button type="button" variant="ghost" size="sm" aria-label={`Remover a parte ${party.name}`}>
                            <Trash2 aria-hidden="true" />
                            Remover
                          </Button>
                        }
                        title="Remover parte?"
                        description={`A parte “${party.name}” será removida deste processo. A remoção fica registrada no histórico.`}
                        confirmLabel="Remover"
                        pendingLabel="Removendo…"
                      />
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
