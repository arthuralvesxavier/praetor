import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CONFIDENTIALITY_LABELS } from "@/domain/enums";
import { formatDateTime, formatNumber, pluralize } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { AppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { listSensitiveDocumentDownloads, type SensitiveDownloadItem, type SensitiveDownloadLog } from "../service";
import { PROCESS_SECTION_IDS } from "../tabs";

function sensitivityLabel(d: Pick<SensitiveDownloadItem, "category" | "confidentiality">): string {
  if (d.category === "sensitive_health") return "Saúde (dado sensível)";
  return CONFIDENTIALITY_LABELS[d.confidentiality];
}

/**
 * Downloads of the sensitive documents of a process (P2.12): who downloaded and when,
 * for the health documents and the confidential or restricted ones the viewer can see.
 * Renders nothing without document:read or when the process has no such document.
 */
export async function SensitiveDownloadsCard({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  if (!can(ctx, "document:read") || !can(ctx, "process:read")) return null;
  let log: SensitiveDownloadLog;
  try {
    log = await listSensitiveDocumentDownloads(ctx, processId);
  } catch (error) {
    if (error instanceof AppError) return null;
    logger.error("process_sensitive_downloads_failed", { processId, error });
    return (
      <p className="text-sm text-muted-foreground">Não foi possível carregar os downloads de documentos sensíveis.</p>
    );
  }
  if (log.sensitiveDocuments === 0) return null;

  return (
    <Card id={PROCESS_SECTION_IDS.sensitiveDownloads} aria-labelledby="downloads-sensiveis-titulo" className="scroll-mt-4 pb-0">
      <CardHeader>
        <CardTitle id="downloads-sensiveis-titulo" className="flex items-center gap-2">
          <ShieldAlert aria-hidden="true" className="size-4 text-muted-foreground" />
          Downloads de documentos sensíveis
        </CardTitle>
        <CardDescription>
          Quem baixou e quando os documentos de saúde, confidenciais ou restritos deste processo (
          {pluralize(log.sensitiveDocuments, "documento visível para você", "documentos visíveis para você")}). Cada download
          fica registrado na trilha de auditoria.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {log.items.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted-foreground">Nenhum download registrado até agora.</p>
        ) : (
          <>
            <Table aria-label="Downloads de documentos sensíveis">
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead>
                  <TableHead>Quem baixou</TableHead>
                  <TableHead>Documento</TableHead>
                  <TableHead>Sensibilidade</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {log.items.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(d.at)}</TableCell>
                    <TableCell>{d.actorName ?? <span className="text-muted-foreground">Usuário não identificado</span>}</TableCell>
                    <TableCell className="min-w-48">
                      <span className="block">{d.documentTitle}</span>
                      {d.versionNumber !== null ? (
                        <span className="block text-xs text-muted-foreground">Versão {d.versionNumber}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Badge tone={d.category === "sensitive_health" ? "alert" : "neutral"}>{sensitivityLabel(d)}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {log.total > log.items.length ? (
              <p className="px-5 py-3 text-xs text-muted-foreground">
                Mostrando os {formatNumber(log.items.length)} downloads mais recentes de {formatNumber(log.total)}.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
