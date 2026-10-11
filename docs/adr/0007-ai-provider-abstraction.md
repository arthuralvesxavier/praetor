# ADR-0007 — Abstração de provedor de IA, saída estruturada e modo demonstrativo

- **Status**: aceita
- **Data**: 2026-10

## Contexto

A IA analisa documentos jurídicos confidenciais e precisa:

- produzir resultados auditáveis (com fontes) e nunca alterar registros;
- resistir a prompt injection vinda dos documentos;
- controlar custo;
- funcionar em demonstrações e testes sem chave de API e sem custo;
- permitir trocar de fornecedor ou modelo.

## Decisão

- Interface `AiProvider { name, model, mode, analyze(req) }` em `src/server/integrations/ai/provider.ts`, com seleção por `AI_PROVIDER` (`auto`/`demo`/`anthropic`) em `getAiProvider()`.
- **`AnthropicProvider`** (modo `live`): SDK oficial e saída estruturada com `betaZodOutputFormat(analysisOutputSchema)`. Modelo padrão `claude-opus-5-5`. Fallback de recusa no servidor habilitado (`server-side-fallback-2026-07-01`, `fallbacks: "default"`). Erros mapeados para `AiProviderError` com `retryable` e mensagem pt-BR.
- **`DemoProvider`** (modo `demo`): regras determinísticas, **sem IA**, com o mesmo contrato de saída. Todo resultado é rotulado como demonstrativo.
- **Contrato único de saída** (`src/domain/analysis.ts`), validado de novo no serviço. Referências a fontes inexistentes são descartadas.
- Prompt fixo e montagem das fontes centralizados em `prompt.ts`: texto não confiável neutralizado dentro de `<source>`. `PROMPT_VERSION` entra no hash de deduplicação.
- Execução sempre assíncrona pela fila, com orçamento mensal por organização e registro de uso e custo estimado.

Detalhes em [AI.md](../AI.md).

## Consequências

- Trocar de fornecedor é implementar uma classe e registrar no seletor (passo a passo em [ARCHITECTURE.md](../ARCHITECTURE.md#como-trocar-o-provedor-de-ia)).
- Demonstrações e testes não dependem de rede nem geram custo. O risco de confundir demonstração com análise real é mitigado pelos rótulos obrigatórios em todas as telas e alertas.
- A saída estruturada simplifica a UI e a validação, mas limita o schema a um subconjunto de JSON Schema (sem regex/min/max; `nullable` em vez de `optional`).
- Mudar provedor ou modelo cancela análises enfileiradas com a configuração antiga, para não misturar resultados.

## Alternativas consideradas

- **SDK do fornecedor direto nos serviços**: acoplamento e testes difíceis.
- **Frameworks de orquestração (LangChain etc.)**: abstração ampla demais para um caso de uso de chamada única estruturada, e mais superfície para dependências.
- **Texto livre + parsing**: frágil, sem garantia de citações nem de formato.
- **Sem modo demonstrativo** (exigir chave): impede demonstrações seguras e testes determinísticos.
