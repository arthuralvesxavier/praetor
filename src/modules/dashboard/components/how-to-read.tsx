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
          Todos os números vêm dos registros cadastrados ou importados no Praetor e consideram apenas o que o seu perfil pode
          acessar (registros confidenciais podem ficar de fora).
        </li>
        <li>Cada indicador abre a lista filtrada que o origina — clique para conferir os registros.</li>
        <li>
          Prazos <strong className="font-medium text-slate-700">vencidos</strong> e{" "}
          <strong className="font-medium text-slate-700">próximos</strong> (próximos {upcomingDays} dias) contam apenas prazos em
          aberto cadastrados manualmente ou já validados. Prazos sugeridos pela IA ficam fora das contagens até a validação
          humana.
        </li>
        <li>Contratos “vencendo” são os vigentes com término nos próximos {contractDays} dias.</li>
        <li>
          Valores financeiros são os informados nos cadastros (pedido, provisão, exposição estimada, valor do contrato). Não
          são estimativas da IA nem previsão de resultado.
        </li>
        <li>
          Itens produzidos pela IA (análises, sugestões e alertas de risco) são apoio à decisão: precisam de revisão por
          um profissional e não substituem a avaliação jurídica.
        </li>
      </ul>
    </details>
  );
}
