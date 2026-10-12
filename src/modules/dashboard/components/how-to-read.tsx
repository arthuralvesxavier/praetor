import { ChevronDown, HelpCircle } from "lucide-react";

/** "Como ler este painel" disclosure (native <details>, no client JS). */
export function HowToRead({ upcomingDays, contractDays }: { upcomingDays: number; contractDays: number }) {
  return (
    <details className="group rounded-lg border border-border bg-surface px-4 py-3 text-sm shadow-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-slate-800 marker:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <HelpCircle aria-hidden="true" className="size-4 text-slate-500" />
        Como ler este painel
        <ChevronDown aria-hidden="true" className="ml-auto size-4 text-slate-500 transition-transform group-open:rotate-180" />
      </summary>
      <ul className="mt-3 list-disc space-y-1.5 pl-5 text-muted-foreground">
        <li>
          Todos os números são calculados a partir dos registros cadastrados ou importados no Praetor e consideram apenas o
          que o seu perfil pode acessar: diretoria, contabilidade e auditoria veem a carteira não sigilosa; advogados e
          analistas, a carteira visível ao seu perfil; escritórios externos, apenas os processos do escritório.
        </li>
        <li>
          A carteira ativa conta cada número CNJ uma vez: as instâncias (1º grau, 2º grau, tribunal superior) de um mesmo
          processo não somam.
        </li>
        <li>
          <strong className="font-medium text-slate-700">Valor da causa</strong> e{" "}
          <strong className="font-medium text-slate-700">valor liquidado</strong> são grandezas diferentes e aparecem lado a
          lado, nunca somadas. Valor liquidado ausente é “não apurado”, não zero.
        </li>
        <li>
          <strong className="font-medium text-slate-700">Exposição oficial</strong> = valor liquidado oficial − garantias
          vinculadas. Sem valor liquidado, a exposição é{" "}
          <strong className="font-medium text-slate-700">estimada</strong> (valor da causa × percentual de risco − garantias) e
          aparece separada. A provisão segue a mesma separação, pelo percentual da classificação vigente.
        </li>
        <li>
          A comparação mensal lê a última competência fechada pela contabilidade, que é imutável; competências em prévia não
          entram na comparação.
        </li>
        <li>Cada indicador abre a lista filtrada que o origina — clique para conferir os registros.</li>
        <li>
          Prazos <strong className="font-medium text-slate-700">vencidos</strong> e{" "}
          <strong className="font-medium text-slate-700">próximos</strong> (próximos {upcomingDays} dias) contam apenas prazos em
          aberto cadastrados manualmente ou já validados. Prazos sugeridos pela IA ficam fora das contagens até a validação
          humana. Contratos “vencendo” são os vigentes com término nos próximos {contractDays} dias.
        </li>
        <li>
          As análises preliminares desta versão são uma simulação demonstrativa (sem IA real) e os e-mails são simulados:
          nada disso é apresentado como fato do processo.
        </li>
      </ul>
    </details>
  );
}
