"use client";

import * as Popover from "@radix-ui/react-popover";
import { HelpCircle, X } from "lucide-react";

/**
 * "Como ler este painel": a help icon in the page header that opens a popover (Radix:
 * the trigger is a button with aria-expanded, Escape and a click outside close it, focus
 * returns to the trigger). `defaultOpen` is only used by the server-render tests.
 */
export function HowToRead({
  upcomingDays,
  contractDays,
  defaultOpen = false,
}: {
  upcomingDays: number;
  contractDays: number;
  defaultOpen?: boolean;
}) {
  return (
    <Popover.Root defaultOpen={defaultOpen}>
      <Popover.Trigger
        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-slate-700 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[state=open]:bg-slate-100"
        aria-label="Como ler este painel"
      >
        <HelpCircle aria-hidden="true" className="size-4 text-slate-500" />
        <span aria-hidden="true">Como ler</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={16}
          className="z-50 max-h-[min(42rem,calc(100dvh-6rem))] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-surface p-4 text-sm shadow-xl data-[state=open]:animate-fade-in focus-visible:outline-none"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-semibold text-slate-900">Como ler este painel</p>
            <Popover.Close
              className="-mt-1 -mr-1 inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-ring"
              aria-label="Fechar"
            >
              <X aria-hidden="true" className="size-4" />
            </Popover.Close>
          </div>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted-foreground">
            <li>
              Todos os números são calculados a partir dos registros cadastrados ou importados no Praetor e consideram apenas o
              que o seu perfil pode acessar: diretoria, contabilidade e auditoria veem a carteira não sigilosa; advogados e
              analistas, a carteira visível ao seu perfil; escritórios externos, apenas os processos do escritório.
            </li>
            <li>
              A carteira ativa conta cada número CNJ uma vez: as instâncias (1º, 2º e 3º grau) de um mesmo processo não somam.
            </li>
            <li>
              <strong className="font-medium text-slate-700">Valor da causa</strong> e{" "}
              <strong className="font-medium text-slate-700">valor apurado</strong> são grandezas diferentes e aparecem lado a
              lado, nunca somadas. Valor apurado ausente é “não apurado”, não zero.
            </li>
            <li>
              <strong className="font-medium text-slate-700">Exposição líquida</strong> = valor apurado vigente menos as
              garantias vinculadas, processo a processo e nunca negativa. Sem valor apurado, a exposição é{" "}
              <strong className="font-medium text-slate-700">estimada</strong> (valor da causa × percentual de risco menos as
              garantias) e aparece separada. A provisão segue a mesma separação e, sem classificação de risco, não é
              calculada (não vale zero).
            </li>
            <li>
              A comparação mensal lê a última competência fechada pela contabilidade, que é imutável; competências em prévia não
              entram na comparação. Aumento ou redução só aparecem quando o valor existe nos dois lados, na mesma base.
            </li>
            <li>
              Os números com link abrem a lista de onde vêm; o enunciado de cobertura do valor apurado abre a fila de conferência
              de valores.
            </li>
            <li>
              Em “Mais indicadores”, prazos <strong className="font-medium text-slate-700">vencidos</strong> e{" "}
              <strong className="font-medium text-slate-700">próximos</strong> (próximos {upcomingDays} dias) contam apenas
              prazos em aberto cadastrados manualmente ou já validados. Prazos sugeridos pela IA ficam fora das contagens até a
              validação humana. Contratos “vencendo” são os vigentes com término nos próximos {contractDays} dias.
            </li>
            <li>
              As análises preliminares desta versão são uma simulação demonstrativa (sem IA real) e os e-mails são simulados:
              nada disso é apresentado como fato do processo.
            </li>
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
