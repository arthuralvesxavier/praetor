import { ChartPie } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Estado de configuração de /paineis-bi: explica o que falta, sem erro técnico.
 * Quem administra a organização recebe o atalho para a configuração.
 */
export function BiSetupState({ hint, canConfigure }: { hint: string | null; canConfigure: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ChartPie aria-hidden="true" className="size-4 text-muted-foreground" />
          Painéis Power BI ainda não configurados
        </CardTitle>
        <CardDescription>
          {hint ? `${hint} ` : ""}Quando estiverem prontos, os painéis mostram a carteira no Power BI com as mesmas regras de
          acesso do Praetor: cada pessoa vê só os processos que já vê aqui.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm text-slate-700">
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Registrar um aplicativo no Microsoft Entra ID, liberar o acesso dele ao workspace do Power BI e informar as
            variáveis POWERBI_TENANT_ID, POWERBI_CLIENT_ID e POWERBI_CLIENT_SECRET no servidor do Praetor.
          </li>
          <li>
            Criar o usuário de banco somente leitura (script bi-setup) e montar o relatório no Power BI Desktop sobre as
            visões do schema bi, com o papel de segurança que filtra a tabela de acessos pelo usuário.
          </li>
          <li>Publicar o relatório no workspace e cadastrar os ids na configuração dos painéis do Praetor.</li>
        </ol>
        <p className="text-muted-foreground">
          O passo a passo completo, para quem não é da área técnica, está no guia docs/POWER_BI.md do Praetor.
        </p>
        {canConfigure ? (
          <div>
            <ButtonLink href="/admin/integracoes/power-bi">Configurar painéis</ButtonLink>
          </div>
        ) : (
          <p className="font-medium text-slate-800">Peça ao administrador do Praetor para concluir a configuração.</p>
        )}
      </CardContent>
    </Card>
  );
}
