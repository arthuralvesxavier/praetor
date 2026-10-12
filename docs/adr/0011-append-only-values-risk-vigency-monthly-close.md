# ADR-0011 — Valores append-only, vigência de risco e fechamento mensal imutável

- **Status**: aceita
- **Data**: 2026-10

## Contexto

O caderno de requisitos parte de duas premissas: "todo valor exibido precisa ser rastreável até um documento dos autos" e "dado nunca é sobrescrito — toda apuração é um registro novo, com data e fonte". A planilha que o sistema substitui perde a data de cada número, mistura valor da causa e valor liquidado, trata vazio como zero e não reproduz a provisão de meses passados. Contabilidade e auditoria precisam saber quanto era o passivo em qualquer data e ter competências fechadas que não mudam (RF-09, RF-11, RF-16, RN-02 a RN-07, RN-10, RN-11, RNF-14).

## Decisão

- **Valorações append-only** (`process_valuations`): o valor nunca é atualizado. Nova apuração é um novo registro com tipo, data-base, instância, origem (peça, sistema oficial, planilha, manual, simulação), rastreio documental (documento, versão, página, trecho) e confiança. Só o status e os campos de conferência mudam: `proposed` → `official` → `superseded` (quando chega uma oficial mais nova do mesmo tipo e instância), ou `rejected`. Corrigir na conferência = rejeitar a original e criar uma nova oficial que aponta para ela. Quitação (RN-06) = nova valoração de liquidado igual a zero com motivo "Quitação".
- **Oficial exige pessoa identificada** (RN-11): `reviewed_by_id` obrigatório; valores importados, extraídos ou lançados por quem não tem `contingency:approve` entram como propostos; conferência em lote só acima do limiar de confiança configurado.
- **Classificação de risco com vigência** (`process_risk_assessments`): cada classificação é um registro com percentual, parecer obrigatório, `effective_from` e versão das regras. A vigente numa data é a oficial de maior `effective_from` ≤ data. Sugestões por regra nascem propostas e nunca valem sozinhas.
- **Espelhos desnormalizados** no processo (liquidado, causa, risco, provisão) só para listas e filtros, recalculados pelo serviço de contingências na mesma transação; a fonte da verdade é o histórico.
- **Regras puras** em `src/domain/contingency.ts` para exposição e provisão: causa e liquidado nunca somados (RN-02), nulo não é zero (RN-03), exposição = liquidado − garantias vinculadas, ou causa ponderada como estimativa (RN-04, RN-07), provisão = base × percentual vigente (RN-05).
- **Fechamento mensal** (`portfolio_snapshots` + `portfolio_snapshot_items`): a prévia pode ser recalculada; ao fechar (`snapshot:close`, pessoa identificada), a competência fica **imutável** — gerar ou fechar de novo é recusado. Os itens guardam a posição de cada processo na data-base e os parâmetros usados (percentuais e versão das regras). Relatórios de competência fechada leem os itens armazenados, nunca recalculam (RN-10). Mudança de percentual incrementa `rulesVersion` (RNF-14) e não altera competências fechadas.
- As garantias são editáveis (com auditoria e exclusão lógica), mas a posição em data passada considera o status e as datas de depósito e de mudança de situação.

## Consequências

- "Quanto era o passivo em tal data" é respondido pelo histórico (`positionAt`), e relatórios antigos continuam reproduzíveis.
- Divergências (RN-08) viram propostas registradas, não sobrescritas; a decisão de qual fonte prevalece fica com uma pessoa na fila de conferência.
- Mais linhas e consultas mais elaboradas (última oficial por tipo e instância, vigência por data); por isso os espelhos no processo.
- A imutabilidade é garantida **pela aplicação**: o banco não impede um `UPDATE` direto. Proteção no banco (gatilhos, permissões por coluna) fica para avaliação futura.
- Limitações registradas: aprovar uma sugestão de risco altera o prefixo do parecer e a vigência do registro proposto; o "processo ativo na data-base" é derivado de situação e datas; relatórios de competência fechada aplicam a visibilidade atual dos processos.
- O fechamento é manual: a rotina diária só atualiza a prévia do mês corrente.

## Alternativas consideradas

- **Colunas de valor no processo, atualizadas no lugar** (como na v1 e na planilha): simples, mas perde histórico, origem e data, e não sustenta provisão auditável.
- **Tabela de auditoria como histórico de valores**: a auditoria registra mudanças, mas não é modelada para consulta por data, tipo e instância nem para conferência.
- **Recalcular competências passadas a partir do estado atual**: muda números já entregues à contabilidade quando percentuais ou valores mudam — viola RN-10 e RNF-14.
- **Fechamento automático no último dia do mês**: retirado desta versão para que o fechamento seja um ato identificado da contabilidade ou da gestão.
