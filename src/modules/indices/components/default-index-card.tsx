import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AuthContext } from "@/server/auth/context";
import { can } from "@/server/auth/permissions";
import { getDefaultCorrectionIndex } from "../service";
import { DefaultCorrectionIndexForm } from "./default-index-form";

/**
 * Settings card for /admin/configuracoes (wired by the integrator): the
 * organization's default correction index (`settings.contingency.defaultCorrectionIndex`).
 * `admin:organization` only; renders nothing otherwise.
 */
export async function DefaultCorrectionIndexCard({ ctx }: { ctx: AuthContext }) {
  if (!can(ctx, "admin:organization")) return null;
  const current = await getDefaultCorrectionIndex(ctx);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Índice de atualização dos valores</CardTitle>
        <CardDescription>
          Gravado em cada novo valor registrado (lançamento, documento, planilha ou conferência) e usado para mostrar o valor
          atualizado ao lado do valor original. Mudar o padrão não altera os valores já registrados; os anteriores a esta
          opção aparecem como sem índice informado. A escolha do índice adequado a cada caso é do advogado responsável: o sistema não
          aplica regra jurídica sobre isso. O valor atualizado é calculado na consulta e nunca substitui o valor original.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {current === "none" ? (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            O padrão atual é Sem atualização: cada novo valor é gravado sem índice de atualização. Enquanto o valor está em
            conferência, quem registra valores pode trocar o índice dele. Depois que o valor é oficial, somente quem confere
            valores troca o índice: um novo registro oficial, com o mesmo valor e a mesma data-base, substitui o atual, que
            continua no histórico. Escolha o padrão antes dos lançamentos, se a organização usa um índice.
          </p>
        ) : null}
        <DefaultCorrectionIndexForm current={current} />
      </CardContent>
    </Card>
  );
}
