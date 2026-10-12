import { FileText } from "lucide-react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Timeline } from "@/components/ui/timeline";
import { formatDate } from "@/lib/format";
import type { ContractLifecycleEvent } from "../service";

/** Renewal / termination history of a contract (recorded through "Registrar renovação/rescisão"). */
export function ContractLifecycleCard({ events }: { events: ContractLifecycleEvent[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3">Renovações e rescisão</CardTitle>
        <CardDescription>Registros feitos pela equipe, com o documento de suporte quando informado.</CardDescription>
      </CardHeader>
      <CardContent>
        <Timeline
          emptyMessage="Nenhuma renovação ou rescisão registrada."
          items={events.map((e) => ({
            id: e.id,
            date: e.createdAt,
            title: e.kind === "renewal" ? "Renovação registrada" : "Rescisão registrada",
            badge: (
              <StatusBadge label={e.kind === "renewal" ? "Renovação" : "Rescisão"} tone={e.kind === "renewal" ? "success" : "neutral"} />
            ),
            description:
              e.kind === "renewal"
                ? `Término: ${formatDate(e.previousEndDate, "indeterminado")} → ${formatDate(e.newEndDate, "indeterminado")}${e.note ? `\n${e.note}` : ""}`
                : `Efeito em ${formatDate(e.terminationDate, "data não informada")} (término anterior: ${formatDate(e.previousEndDate, "indeterminado")})${e.note ? `\n${e.note}` : ""}`,
            meta: (
              <>
                {e.actorName ? `Por ${e.actorName}` : "Pelo sistema"}
                {e.document ? (
                  <>
                    {" · "}
                    {e.document.visible ? (
                      <Link
                        href={`/documentos/${e.document.id}`}
                        className="inline-flex items-center gap-1 font-medium text-primary-700 underline-offset-2 hover:underline"
                      >
                        <FileText aria-hidden="true" className="size-3.5" />
                        {e.document.title}
                      </Link>
                    ) : (
                      <span>{e.document.title}</span>
                    )}
                  </>
                ) : null}
              </>
            ),
          }))}
        />
      </CardContent>
    </Card>
  );
}
