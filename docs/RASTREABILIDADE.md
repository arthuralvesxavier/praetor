# Rastreabilidade dos requisitos (Praetor v2)

Matriz entre o caderno de requisitos do cliente ("Levantamento de requisitos: sistema de gestão de passivo e carteira judicial") e o que existe no Praetor v2, atualizada em 12/10/2026 com as entregas posteriores ao commit `fe5564b` (P0, P1, coleta no DataJud, API de entrada, Power BI, desinche da P0.6), ainda sem commit. Cada linha diz o status, onde está (rota ou módulo) e uma justificativa curta. As afirmações foram conferidas no código; nenhuma tela foi usada num navegador com o servidor real até esta redação (ver [STATUS.md](STATUS.md#estado-da-verificação)).

**Legenda de status**

| Status | Significado |
|---|---|
| **Atendido** | Implementado e operacional (com dados reais informados por pessoas, importados ou coletados de fonte oficial). |
| **Atendido parcialmente** | Parte do requisito existe; a justificativa diz o que falta. |
| **Simulado** | Existe apenas como simulação demonstrativa, rotulada como tal (sem IA real, sem envio real). |
| **Pendente (não integrado)** | Depende de integração externa que não existe nesta versão. |
| **Pendente** | Não implementado. |

Os requisitos jurídicos (RJ-xx), riscos (RK-xx) e documentos (DOC-xx) do caderno não estão nesta matriz; vários são contratuais ou dependem de cadastro nos tribunais. A coleta no DataJud depende de `DATAJUD_API_KEY` configurada; sem ela, os itens que a usam ficam inativos (e a tela diz isso).

## Requisitos funcionais (RF)

| ID | Requisito (resumo) | Status | Onde | Justificativa |
|---|---|---|---|---|
| RF-01 | Cadastro e consulta de processos com filtros por tribunal, grau, fase, cidade, unidade, classe, risco e faixa de valor | Atendido | `/processos`, `modules/processes` | Lista única com esses filtros, fase e instância (grau) como eixos separados, paginação no servidor, ordenação e totais de causa e valor apurado separados. |
| RF-02 | Importação da base atual com validação CNJ, duplicidade e relatório de inconsistências | Atendido | `/importacoes`, `modules/imports` | Análise antes de gravar, inconsistências por linha (CSV), divergências entre abas, confirmação em transação, desfazer e distribuição em segundo plano. |
| RF-03 | Monitoramento diário de movimentação | Atendido parcialmente | rotina `court_sync`, `modules/court-sync`, aba "Partes e andamento" | Rotina automática consulta toda a carteira ativa na API pública do DataJud (intervalo por processo, 24 h por padrão) e registra só movimentações novas, mudanças de fase inequívocas (para frente), julgamento, baixa e extinção como alerta. Falta: só o DataJud (sem MNI nem diários), que tem atraso em relação aos tribunais. |
| RF-04 | Atualização automática de capa e partes pelo sistema oficial | Atendido parcialmente | `modules/court-sync` | Órgão julgador, classe, cidade/UF, ajuizamento e assuntos vêm do DataJud, preenchendo só campos vazios; divergências viram nota de conferência. O DataJud não informa partes nem valor da causa (exigiriam MNI). |
| RF-05 | Detecção de processo novo com alerta ao responsável | Atendido parcialmente | `POST /api/v1/processos`, `/entrada` | Sistemas externos enviam processos novos pela API de entrada; o processo entra no fluxo da entrada (distribuição, alerta `new_process_received`, análise e e-mail simulados), completado pelo DataJud. Nenhum tribunal é varrido em busca de ação nova contra a empresa (o DataJud só consulta números conhecidos). Na demonstração há também a chegada simulada. |
| RF-06 | Detecção de saída do acervo com classificação do motivo | Atendido parcialmente | `modules/court-sync`, `/processos` | Baixa, arquivamento, extinção e trânsito informados pelo DataJud viram alerta e pendência de conferência; subida de grau cria o vínculo da instância. O encerramento é sempre humano, com motivo (inclusive perda do patrocínio). Perda do patrocínio não é detectada. |
| RF-07 | Captura do valor liquidado a partir das peças, com página e trecho | Simulado | `/analises-preliminares`, `/contingencias/revisao`, pedidos | Peças não são baixadas dos tribunais. A análise preliminar simulada lê documentos enviados por pessoas e propõe o valor com página e trecho (origem "Extração simulada") e sugere os **pedidos** do processo (pendentes de confirmação). Lançamento manual com documento, página e trecho é operacional. |
| RF-08 | Fila de revisão humana com a página do documento ao lado | Atendido | `/contingencias/revisao` | Valor proposto ao lado do texto da página com o trecho destacado, o **índice de atualização e o valor atualizado**; aprovar, corrigir ou rejeitar; a aprovação é recusada se o índice mudou depois que a tela abriu; lote só acima do limiar e nunca para extração simulada. |
| RF-09 | Histórico de valores (série temporal, posição em data passada) | Atendido | aba "Valores e acordos", `modules/contingency`, `modules/indices` | Valorações append-only com substituição; linha do tempo e posição em data passada (inclusive a remoção do valor da causa); valor atualizado por IPCA-E, IPCA, INPC, Selic ou TR do Banco Central, calculado na leitura e nunca somado. |
| RF-10 | Garantias e deduções com saldo líquido exposto | Atendido | aba "Valores e acordos", `/dashboard` | Depósito judicial e recursal, penhora, seguro garantia, carta de fiança; exposição líquida = valor apurado menos garantias vinculadas, nunca negativa, com a lista do que foi abatido. O alvará não é um tipo próprio: aparece como mudança de situação da garantia (liberada ao autor ou devolvida à empresa), que deixa de abater. |
| RF-11 | Risco e percentual por processo, provisão sugerida e parecer | Atendido | aba "Valores e acordos", `/contingencias` | Classificação com percentual, parecer, vigência e versão das regras; risco também **por pedido**, com a classificação do processo derivada dos pedidos; provisão calculada. |
| RF-12 | Régua automática de risco, sempre como proposta | Atendido parcialmente | aba "Valores e acordos", `modules/claims` | Sugestão por regra (fase, instância, encerramento, valor apurado), sempre proposta. Os pedidos avaliados por pessoas derivam a classificação do processo. Não usa histórico de resultado em casos semelhantes; sem IA. |
| RF-13 | Painel de pendências (pauta, prazo, acordo a vencer, depósito parado, execução sem valor) | Atendido | `/alertas`, `/dashboard`, `/contingencias/garantias` | Painel com 9 áreas, faixa "Exige decisão agora" no painel e na ficha, alertas gerados por rotinas (inclusive DataJud e fechamento) e resolução com registro de quem resolveu. |
| RF-14 | Notificação por e-mail/mensagem, resumo diário e alerta imediato | Simulado | `/emails` | E-mails apenas simulados (nada é enviado): análise pronta, atribuição de responsável, lembrete de audiência e resumo diário (sob demanda); sem mensageria. |
| RF-15 | Dashboard executivo com leitura dupla causa/liquidado e comparação mensal | Atendido | `/dashboard`, `/paineis-bi` | Exposição líquida, cobertura do valor apurado, gráfico por tribunal, instância, fase, cidade, empresa e unidade, comparação com a última competência fechada. Painéis Power BI sobre uma camada governada, com as mesmas regras de acesso. |
| RF-16 | Relatório de provisão por competência, pronto para a contabilidade | Atendido | `/contingencias/provisao`, `/relatorios?tipo=provisao` | Competência fechada imutável, bloqueio do fechamento com processos sem classificação (só com justificativa), classificação, provisão, movimentação, CSV e **memória de cálculo em XLSX e PDF** gerada dos itens guardados. |
| RF-17 | Exportação em Excel e PDF no layout atual, com abas consolidado e instância | Atendido parcialmente | `/api/processes/export`, `/api/reports/<tipo>`, `/api/provision-memo` | Excel/CSV com as colunas da planilha, aba consolidada e uma por instância; relatórios em CSV/XLSX. PDF gerado no servidor só para a memória de cálculo e os relatórios jurídicos; os demais relatórios em PDF pela impressão do navegador. |
| RF-18 | Carta de auditoria com relação de processos e posição por data-base | Atendido parcialmente | `/relatorios?tipo=auditoria`, `/relatorios-juridicos` | Layout formal de impressão com ressalvas; data-base = competência fechada ou hoje. O motor dos relatórios jurídicos em PDF (numeração, fontes conferidas, aprovação, versões) está pronto, mas os geradores R1 a R4 estão pendentes. |
| RF-19 | Repositório de peças indexadas por processo e tipo, com busca textual | Atendido parcialmente | `/documentos`, `/busca` | Documentos por processo e categoria, SHA-256, versões e texto extraído. A busca não pesquisa o conteúdo (só a pergunta à base na Central de IA). Sem OCR; peças não são baixadas dos tribunais. |
| RF-20 | Atribuição de responsável (advogado, escritório, unidade) com painel por responsável | Atendido | `/distribuicao`, `modules/distribution` | Regras com prioridade (fixo, rodízio, menor carga), redistribuição com motivo, aviso por e-mail simulado e painel de carga. |
| RF-21 | Portal do escritório externo restrito à própria carteira | Atendido | perfil "Escritório externo" | No mesmo aplicativo: vê só os processos do escritório e as pessoas ligadas a eles, registra andamento, anexa peças e propõe valores (entram como propostos). |
| RF-22 | Trilha de auditoria consultável e exportável | Atendido | `/admin/auditoria` | Diff por campo, filtros, CSV até 10.000 registros; a própria exportação é auditada; resumos de totais sigilosos ocultos para quem não fecha a competência. |
| RF-23 | Perfis de diretoria, jurídico interno, escritório externo, contabilidade e auditoria | Atendido | `src/server/auth/permissions.ts`, `/admin/permissoes` | Oito perfis com permissões e visibilidade distintas. |
| RF-24 | Painel de saúde da coleta | Atendido | `/admin/integracoes`, `/admin/integracoes/datajud` | Saúde do DataJud por tribunal (última execução, consultados, encontrados, falhas, processos aguardando, alerta após falhas seguidas), fila, rotinas, importações, API de entrada, Power BI e séries de índices. |

## Regras de negócio (RN)

| ID | Regra (resumo) | Status | Onde | Justificativa |
|---|---|---|---|---|
| RN-01 | Número CNJ é a chave; subir de grau cria vínculo, não registro novo | Atendido | `process_instances`, processes, imports, DataJud, API de entrada | Um processo por CNJ; instâncias como vínculos (inclusive as encontradas pelo DataJud); a API de entrada não duplica número existente. |
| RN-02 | Valor da causa e liquidado nunca se somam | Atendido | telas, exportações, memória de cálculo, relatórios jurídicos, visões do BI | Colunas e totais sempre separados e rotulados; regra também no domínio (`domain/contingency.ts`, `domain/legal-reports.ts`). |
| RN-03 | Vazio não é zero | Atendido | banco, telas, CSV, XLSX, PDF | Nulo = "Não apurado"/"Não informado" na tela, célula vazia na exportação, "Sem provisão" na memória; pedido sem valor nunca vale zero. |
| RN-04 | Exposição líquida = liquidado − garantias vinculadas; sem liquidado, causa ponderada como estimativa | Atendido | `netExposure`, painel, aba de valores | Nunca negativa; estimativa sinalizada e mostrada à parte. |
| RN-05 | Provisão = base × percentual da classificação vigente; mudança de percentual não altera competência fechada | Atendido | `provisionFor`, fechamento mensal | Classificação vigente por data; competência fechada guarda os parâmetros. Decisões abertas: provisão estimada sem abater garantias e soma pelos pedidos x provisão oficial ([STATUS.md](STATUS.md#decisões-de-produto-registradas)). |
| RN-06 | Extinção por satisfação = nova valoração zero com motivo de quitação | Atendido | "Registrar quitação" na aba de valores | Histórico preservado. Não é aplicado automaticamente pela importação. |
| RN-07 | Estimativa sempre marcada e nunca sem ressalva em relatório contábil | Atendido | contingências, relatórios, CSV, memória de cálculo | Exposição e provisão estimadas separadas e rotuladas. |
| RN-08 | Prevalência de fonte; divergência registrada, não apagada | Atendido parcialmente | importação, fila de conferência, DataJud | Divergências viram valores propostos ou notas de conferência. A ordem de prevalência não é automática: a decisão é humana. |
| RN-09 | Processo em duas instâncias é um só registro na contagem | Atendido | carteira, relatórios, painel | Contagens por CNJ único. |
| RN-10 | Fechamento mensal congela snapshot; competência fechada é lida do snapshot | Atendido parcialmente | `/contingencias/provisao` | Competência fechada é imutável e os relatórios, a memória de cálculo e o BI leem os itens guardados. O fechamento é ação humana (`snapshot:close`), bloqueado por processo sem classificação salvo com justificativa; a rotina só atualiza a prévia. |
| RN-11 | Extração abaixo do limiar não vira oficial sem confirmação humana identificada | Atendido | `modules/contingency` | Todo valor extraído entra como proposto; oficial exige revisor identificado; o valor da causa de quem não confere valores também entra como proposto. |
| RN-12 | Perda de patrocínio: sai da carteira ativa, acesso aos autos bloqueado, histórico mantido | Atendido parcialmente | `/processos` | Sai da carteira ativa com motivo e o histórico permanece. Não há registro de procuração nem bloqueio de acesso aos autos. |

## Requisitos não funcionais (RNF selecionados)

| ID | Requisito (resumo) | Status | Onde | Justificativa |
|---|---|---|---|---|
| RNF-02 | Resiliência da coleta: fila com retentativa progressiva e registro do erro, sem perder o lote | Atendido | jobs `court_sync.run`, `court_sync_states` | Um job por tribunal, continuação automática, espera de 1 h, 2 h, 4 h… após falha, erro saneado por processo e por execução; um tribunal fora do ar não derruba a consulta. |
| RNF-03 | Limite de requisição por minuto por tribunal, com filas separadas | Atendido | `src/server/integrations/courts` | Limite configurável por tribunal (padrão 20/min), um job por tribunal. O limite fica em memória por worker. |
| RNF-04 | Idempotência: reprocessar não duplica processo, movimento nem valoração | Atendido | importação, DataJud, API de entrada, fila | Reimportar não duplica; movimentações do DataJud identificadas por código, data e grau (índice único); `Idempotency-Key` na API; jobs com chave de deduplicação. |
| RNF-05 | Auditabilidade: toda escrita sensível gera registro imutável com usuário, data, valor anterior e novo | Atendido parcialmente | `recordAudit`, `audit_logs` | Registro na mesma transação, com diff de/para. Append-only só na aplicação (sem proteção no banco); campos protegidos e textos longos não guardam o valor. |
| RNF-07 | Backup diário, teste trimestral de restauração, recuperação em até 4 h | Atendido parcialmente | `npm run db:backup` / `db:restore` | Scripts manuais de backup lógico e restauração. Sem agendamento diário, rotina de teste ou objetivo de recuperação medido. |
| RNF-09 | Observabilidade: volume coletado, erro por tribunal, fila de revisão, latência da extração | Atendido parcialmente | `/admin/integracoes`, `/admin/integracoes/datajud`, `/contingencias/revisao` | Volume consultado e encontrado, falhas e duração por tribunal, fila de jobs, rotinas, fila de conferência, requisições da API. Latência da extração de texto não é medida. |
| RNF-10 | Portabilidade: extrair a base completa em formato aberto | Atendido parcialmente | exportações CSV/XLSX, `db:backup`, schema `bi` | Carteira, relatórios, fechamento, memória de cálculo e auditoria exportáveis; camada de leitura para o Power BI; backup lógico em JSON só pelo operador. |
| RNF-12 | Uso por jurídico sem formação técnica, telas densas, exportação a um clique | Atendido parcialmente | todas as telas | Ficha em 6 abas, carteira em uma linha por processo, painel em 3 blocos, textos sem códigos internos; usabilidade não verificada em navegador. |
| RNF-13 | Multiempresa e multiunidade com segregação de visão | Atendido parcialmente | empresas, unidades, filtros, BI | Segregação por unidade (advogado, analista) e por escritório externo, também nos painéis Power BI. Não há segregação por empresa. |
| RNF-14 | Versionamento de regra de provisão/risco | Atendido | configurações de contingência, fechamento, pedidos | Mudança de percentual incrementa a versão; classificações, avaliações de pedidos e fechamentos guardam a versão e os parâmetros. |

## Telas (TE)

| ID | Tela (resumo) | Status | Onde | Justificativa |
|---|---|---|---|---|
| TE-01 | Dashboard executivo | Atendido | `/dashboard`, `/paineis-bi` | "Exige decisão agora", carteira com exposição líquida e gráfico por dimensão, comparação com a competência fechada anterior; painéis Power BI. |
| TE-02 | Carteira com filtro avançado, busca por número e parte e exportação do recorte | Atendido | `/processos` | Uma linha por processo, busca por número (com ou sem pontuação), título e parte; exportação respeita os filtros. |
| TE-03 | Ficha do processo (capa, partes, movimentações, valores, garantias, risco, peças, auditoria) | Atendido | `/processos/[id]` | Seis abas (resumo, partes e andamento com a linha do tempo única e o DataJud, valores e acordos com pedidos e cenários, prazos e audiências, documentos e análises, histórico). |
| TE-04 | Fila de revisão com aprovar, corrigir ou rejeitar | Atendido | `/contingencias/revisao` | Página do documento ao lado, índice e valor atualizado, um clique por decisão. |
| TE-05 | Alertas e pendências | Atendido | `/alertas` | "Processo novo" vem de entradas registradas, da API de entrada ou da chegada simulada; movimentações relevantes vêm do DataJud. |
| TE-06 | Provisão e contabilidade com exportação para o ERP | Atendido parcialmente | `/contingencias/provisao` | Posição, movimentação, memória de cálculo (XLSX e PDF), CSV e bloqueio do fechamento; sem integração com ERP. |
| TE-07 | Saúde da coleta | Atendido | `/admin/integracoes/datajud` | Sincronizações por tribunal, falhas, tempo desde a última consulta, processos aguardando e tamanho das filas. |
| TE-08 | Painel por responsável e escritório | Atendido | `/distribuicao?aba=carga`, `/relatorios?tipo=responsaveis` | Volume, causa e valor apurado, exposição e pendências. |
| TE-09 | Portal do escritório | Atendido | perfil "Escritório externo" | Visão restrita à própria carteira, com andamento e anexo de peça. |
| TE-10 | Auditoria: alterações, acessos a sigilosos e exportação | Atendido | `/admin/auditoria`, ficha do processo | Atalho "Acessos a processos sigilosos", CSV e, na ficha, os downloads de documentos sensíveis. |
| TE-11 | Administração: perfis, usuários, parâmetros de risco, limiares, credenciais em cofre | Atendido parcialmente | `/admin/*` | Tudo exceto cofre de credenciais: segredos (DataJud, Power BI, IA) ficam em variáveis de ambiente; chaves da API de entrada só como hash. |
| TE-12 | Inteligência de passivo por unidade, função e pedido | Atendido parcialmente | `/inteligencia-preventiva` | Indicadores calculados da carteira e pedidos recorrentes (das análises **simuladas** sobre documentos fictícios); sem dados de função (RH não integrado). |

## Dados pessoais (PD)

| ID | Dado e controle exigido | Status | Onde | Justificativa |
|---|---|---|---|---|
| PD-01 | Nomes: acesso por perfil e log de leitura em processo sigiloso | Atendido | `access.ts`, `legal_process.view_confidential` | Cada abertura de processo sigiloso é registrada, no máximo uma por usuário, processo e hora. As visões do Power BI não têm nomes de partes. |
| PD-02 | CPF: mascaramento na listagem | Atendido | aba "Partes e andamento", exportação | Mascarado nas listas, na aba de partes e na exportação; completo só no formulário de edição da parte; nunca auditado. |
| PD-03 | Vínculo e remuneração: segregação por unidade e vedação de exportação em massa | Pendente | | Não há campos de vínculo e remuneração. |
| PD-04 | Atestado, laudo e CAT: somente o advogado responsável | Atendido parcialmente | categoria "Atestado, laudo ou CAT" | Sempre "Restrito"; visível ao responsável do registro (ou escritório do processo), a quem enviou e a administradores e gestores jurídicos; download auditado e listado na ficha; trecho nunca guardado nos relatórios jurídicos. |
| PD-05 | Alegação de assédio ou acidente: só o responsável, fora de painel e exportação | Pendente | | Não há classificação própria. Assédio moral é contado na categoria "dano moral" dos pedidos recorrentes (só contagem). |
| PD-06 | Filiação sindical fora de indicador gerencial | Atendido parcialmente | `preventive-intel/claims.ts` | Excluída dos indicadores por lista de palavras-chave, que pode não captar redações incomuns. |
| PD-07 | Peça integral: hash, download registrado, marca d'água | Atendido parcialmente | `/documentos` | SHA-256, download autenticado e auditado. Sem marca d'água no visualizador (só nos PDFs de relatório jurídico ainda não aprovados). |

## Integrações (INT)

| ID | Fonte | Status | Onde | Justificativa |
|---|---|---|---|---|
| INT-01 | API pública do DataJud | Atendido | `src/server/integrations/courts`, `modules/court-sync` | Coleta automática e consulta avulsa com a chave pública do CNJ (`DATAJUD_API_KEY`). Testada com provedor falso; coleta real de ponta a ponta não registrada nesta revisão. |
| INT-02 | MNI | Pendente (não integrado) | `/admin/integracoes` | Exige certificado e cadastro no tribunal. |
| INT-03 | Consulta pública dos TRTs | Pendente (não integrado) | `/admin/integracoes` | Nenhuma consulta automatizada aos sites. |
| INT-04 | Painel de acervo do PJe | Pendente (não integrado) | `/importacoes`, `/api/v1/processos` (substitutos) | O acervo é carregado pela importação de planilha ou enviado por sistemas externos pela API de entrada. |
| INT-05 | OCR e extração de documento | Atendido parcialmente | `text-extraction.ts` | Extração local de PDF com camada de texto (por página) e DOCX; sem OCR. |
| INT-06 | ERP e contabilidade | Pendente (não integrado) | CSV e memória de cálculo (substitutos) | Arquivos "prontos para a contabilidade"; sem integração direta. |
| INT-07 | Folha de pagamento e RH | Pendente (não integrado) | | Sem integração. |
| INT-08 | Correio e mensageria | Simulado | `/emails`, `integrations/email` | `SimulatedEmailProvider`; nenhum envio. |
| INT-09 | Diário eletrônico | Pendente (não integrado) | `/admin/integracoes` | Publicações e intimações não são capturadas; prazos são cadastrados por pessoas. |

Fontes sem linha própria no caderno: séries de índices do Banco Central (SGS, API pública, operacional) e Power BI (painéis incorporados com segurança por usuário, operacional quando configurado; teste com Power BI real não repetido nesta revisão).
