import Link from "next/link";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { EMAIL_TEMPLATE_LABELS } from "@/domain/enums";
import { formatDateTime } from "@/lib/format";
import type { EmailListItem } from "../service";
import { EmailStatusBadge } from "./email-status-badge";

type Props = {
  items: EmailListItem[];
  /** Hide the process column (inside the process page). */
  hideProcess?: boolean;
  emptyMessage: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  label?: string;
};

/** Simulated e-mails list (Central de e-mails and the process tab). */
export function EmailsTable({ items, hideProcess = false, emptyMessage, emptyDescription, emptyAction, label = "E-mails simulados" }: Props) {
  const colSpan = hideProcess ? 5 : 6;
  return (
    <Table aria-label={label}>
      <TableHeader>
        <TableRow>
          <TableHead className="whitespace-nowrap">Data</TableHead>
          <TableHead>Destinatário</TableHead>
          <TableHead>Assunto</TableHead>
          <TableHead>Modelo</TableHead>
          {hideProcess ? null : <TableHead>Processo</TableHead>}
          <TableHead>Situação</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableEmpty colSpan={colSpan} message={emptyMessage} description={emptyDescription} action={emptyAction} />
        ) : (
          items.map((m) => (
            <TableRow key={m.id} interactive>
              <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                <time dateTime={m.createdAt.toISOString()}>{formatDateTime(m.createdAt)}</time>
              </TableCell>
              <TableCell className="min-w-44">
                <span className="block text-slate-900">{m.toName}</span>
                <span className="block text-xs break-all text-muted-foreground">{m.toAddress}</span>
              </TableCell>
              <TableCell className="min-w-72">
                <Link href={`/emails/${m.id}`} className={tableLinkClasses}>
                  {m.subject}
                </Link>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {m.triggeredById ? `Gerado por ${m.triggeredByName ?? "usuário"}` : "Gerado automaticamente pelo sistema"}
                </span>
              </TableCell>
              <TableCell className="min-w-40 text-sm">{EMAIL_TEMPLATE_LABELS[m.template]}</TableCell>
              {hideProcess ? null : (
                <TableCell className="whitespace-nowrap">
                  {m.processId && m.processNumber ? (
                    <Link href={`/processos/${m.processId}`} className="font-mono text-xs text-primary-700 underline-offset-2 hover:underline">
                      {m.processNumber}
                    </Link>
                  ) : m.processId ? (
                    <span className="text-xs text-muted-foreground">Processo sem acesso</span>
                  ) : (
                    <span className="text-muted-foreground">Sem processo</span>
                  )}
                </TableCell>
              )}
              <TableCell>
                <EmailStatusBadge status={m.status} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
