import { Users } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, tableLinkClasses } from "@/components/ui/table";
import { UserAvatar } from "@/components/ui/user-avatar";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData } from "../service";

function Overdue({ value }: { value: number }) {
  return (
    <span className={cn("tabular-nums", value > 0 ? "font-semibold text-red-700" : "text-muted-foreground")}>
      {formatNumber(value)}
    </span>
  );
}

export function WorkloadTable({ workload }: { workload: DashboardData["workload"] }) {
  const { rows, unassigned } = workload;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pendências por responsável</CardTitle>
        <CardDescription>
          Tarefas abertas e prazos em aberto (manuais ou validados), ordenados por atrasos. Até 10 pessoas.
        </CardDescription>
      </CardHeader>
      <CardContent className={rows.length ? "px-0" : undefined}>
        {rows.length === 0 ? (
          <EmptyState icon={<Users />} title="Nenhuma pendência atribuída" description="Não há tarefas ou prazos em aberto com responsável definido." />
        ) : (
          <Table aria-label="Pendências por responsável">
            <TableHeader>
              <TableRow>
                <TableHead>Responsável</TableHead>
                <TableHead className="text-right">Tarefas abertas</TableHead>
                <TableHead className="text-right">Tarefas atrasadas</TableHead>
                <TableHead className="text-right">Prazos abertos</TableHead>
                <TableHead className="text-right">Prazos vencidos</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.userId}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <UserAvatar name={r.name} size="sm" />
                      <Link
                        href={`/prazos?aba=tarefas&responsavel=${encodeURIComponent(r.userId)}`}
                        className={tableLinkClasses}
                      >
                        {r.name}
                      </Link>
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Link
                      href={`/prazos?aba=tarefas&responsavel=${encodeURIComponent(r.userId)}`}
                      className="hover:underline underline-offset-2"
                      aria-label={`${formatNumber(r.openTasks)} tarefas abertas de ${r.name}`}
                    >
                      {formatNumber(r.openTasks)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">
                    <Overdue value={r.overdueTasks} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <Link
                      href={`/prazos?aba=prazos&situacao=abertos&responsavel=${encodeURIComponent(r.userId)}`}
                      className="hover:underline underline-offset-2"
                      aria-label={`${formatNumber(r.openDeadlines)} prazos abertos de ${r.name}`}
                    >
                      {formatNumber(r.openDeadlines)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">
                    {r.overdueDeadlines > 0 ? (
                      <Link
                        href={`/prazos?aba=prazos&situacao=vencidos&responsavel=${encodeURIComponent(r.userId)}`}
                        className="hover:underline underline-offset-2"
                        aria-label={`${formatNumber(r.overdueDeadlines)} prazos vencidos de ${r.name}`}
                      >
                        <Overdue value={r.overdueDeadlines} />
                      </Link>
                    ) : (
                      <Overdue value={0} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {unassigned.tasks + unassigned.deadlines > 0 ? (
          <p className={cn("pt-3 text-xs text-muted-foreground", rows.length ? "px-5" : undefined)}>
            Sem responsável definido: {formatNumber(unassigned.tasks)} {unassigned.tasks === 1 ? "tarefa" : "tarefas"} e{" "}
            {formatNumber(unassigned.deadlines)} {unassigned.deadlines === 1 ? "prazo" : "prazos"}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
