import { Mail } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/format";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { SIMULATED_EMAIL_BANNER } from "../labels";
import { listEmails } from "../service";
import { EmailsTable } from "./emails-table";

const TAB_LIMIT = 20;

/** "E-mails" tab of the process page: simulated sends about the process visible to ctx. */
export async function ProcessEmailsTab({ ctx, processId }: { ctx: AuthContext; processId: string }) {
  if (!can(ctx, "email:read")) {
    return <p className="text-sm text-muted-foreground">Seu perfil não tem acesso à central de e-mails.</p>;
  }
  const result = await listEmails(ctx, { processId, pageSize: TAB_LIMIT });
  const allHref = `/emails?processo=${processId}`;

  return (
    <div className="flex flex-col gap-4">
      <Callout tone="warning" title={SIMULATED_EMAIL_BANNER}>
        As mensagens abaixo foram apenas registradas para demonstração: nenhuma foi entregue a servidor de e-mail.
      </Callout>
      <Card className="pb-0">
        <CardHeader
          actions={
            result.total > 0 ? (
              <ButtonLink href={allHref} variant="outline" size="sm">
                <Mail aria-hidden="true" />
                Abrir na central
              </ButtonLink>
            ) : null
          }
        >
          <CardTitle>E-mails do processo</CardTitle>
          <CardDescription>
            {result.total > TAB_LIMIT
              ? `Mostrando os ${TAB_LIMIT} mais recentes de ${formatNumber(result.total)}.`
              : "Avisos de análise preliminar, atribuição, prazos e audiências gerados para este processo."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <EmailsTable
            items={result.items}
            hideProcess
            label="E-mails simulados do processo"
            emptyMessage="Nenhum e-mail simulado para este processo."
            emptyDescription="Os avisos aparecem aqui quando a análise preliminar fica pronta, quando o processo é atribuído ou em lembretes."
          />
        </CardContent>
      </Card>
    </div>
  );
}
