# Status do projeto

Versão 2 (outubro de 2026): carteira de processos com contingências, entrada de processos com análise preliminar e e-mail **simulados**, coleta automática no DataJud (CNJ), API de entrada para sistemas externos, painéis Power BI, pedidos do processo com risco derivado, índices de correção do Banco Central, bloqueio do fechamento mensal, memória de cálculo da provisão e o motor dos relatórios jurídicos em PDF, construídos sobre a primeira versão funcional. Esta página separa o que **funciona de verdade** (operacional), o que é **simulado ou demonstrativo** e o que está **pendente**. Atualize-a junto com cada funcionalidade (regra 9 do [AGENTS.md](../AGENTS.md)).

A correspondência com cada requisito do cliente (RF, RN, RNF, TE, PD, INT) está em [RASTREABILIDADE.md](RASTREABILIDADE.md).

## Estado da verificação

**Ajustes do R1 após a revisão, 12/10/2026, ainda sem commit**

- `npx tsc --noEmit -p .` e ESLint nos caminhos alterados: sem erros. `npx vitest run --no-file-parallelism` (PGlite, um arquivo por vez): 168 arquivos passam e 1 é pulado (1.614 testes passam, 4 pulados), incluindo os testes novos dos ajustes em `tests/legal-reports/r1/{rules,content,access}.test.ts` e `tests/legal-reports/pdf-engine.test.ts`.
- Ajustes: o ponto 3.6 da síntese marca como simulação a parte que resume as lacunas da análise preliminar simulada; tribunal e vara / órgão julgador viram lacunas separadas (com o tribunal conhecido e a vara ausente, o R1 marca a lacuna da vara), e a lacuna da análise sobre o cadastro só conta como "não repetida" quando o R1 marca a dele; o parecer do risco (6.2) entra inteiro (só acima de 3.000 caracteres é resumido, em fim de frase, dizendo onde está o texto completo); `deadline:read` só é exigido quando o R1 traz prazo em aberto (a contabilidade vê o R1 sem prazos e sem análise preliminar); tabela curta que não cabe inteira é dividida (cabeçalho repetido) quando cabem o cabeçalho e 3 linhas, sem deixar área grande em branco.
- Amostra `.data/legal-reports-sample/R1-exemplo.pdf` (10 páginas) e `R1-exemplo-aprovado.pdf` regeradas e conferidas página a página (pdf.js no Chrome sem interface, `png/r1v3-p*.png`): a matriz de cenários começa na página 6 (antes ia inteira para a 7, deixando meia página em branco) e a nota da tabela segue na 7 com "(continuação)".
- Segunda rodada (achados da revisão): a lacuna da análise preliminar sobre o cadastro (REG) só deixa de ser repetida quando é, por inteiro, sobre um dado que o R1 lê: pela chave do campo da identificação ou pela frase fixa inteira da simulação (constantes `SIMULATED_RECORD_GAP_TEXTS` e `SIMULATED_RECORD_AMOUNT_LABELS`, usadas também pelo provedor simulado), nunca por palavra-chave (antes "Data de admissão do reclamante" era ligada às partes e descartada). Lacuna incluída ou editada pelo revisor sempre entra, creditada a quem a incluiu ou editou, e a metodologia conta quantas são. A lacuna do dígito verificador (CNJ) é contada como "problema apontado nos pontos de atenção (seção 8)", não como "dado marcado como não localizado". Autores e réus são tratados por polo (sem parte no polo ativo, a lacuna da análise sobre os autores entra). O resumo do parecer não termina em abreviação ("Cia.", "Exmo.", "Ilmo.", "S.A.", "Ltda.", letra isolada). Sem instâncias registradas, a síntese 3.1 repete o marcador da vara que falta ("(TJSP, vara / órgão julgador [DADO NÃO LOCALIZADO])"). A nota de tabela sem legenda que segue sozinha para a página seguinte leva o título "Nota da tabela da página anterior (continuação)". Amostra regerada e vista página a página (`png/r1v4-p*.png`): conteúdo e paginação iguais aos da rodada anterior.

**Relatório de Processo (R1), 12/10/2026, commit 7dadc89**

- `npx tsc --noEmit -p .` e ESLint nos caminhos alterados: sem erros. `npx vitest run` (PGlite): 168 arquivos passam e 1 é pulado (1.608 testes passam, 4 pulados), incluindo `tests/legal-reports/r1/**` (regras, automação, permissões, conteúdo e amostra).
- Correções da revisão do R1: síntese com o tribunal da instância atual, notas de fonte coerentes, ponto de lacunas como Inferência, lista completa de dados não localizados (inclusive células de tabela) com a mesma contagem da nota metodológica, todas as lacunas da análise preliminar, escritório externo com leitura dos R1 do escritório, omissão de CPF e CNPJ, visibilidade pelas permissões do conteúdo, cenários propostos gravados só na emissão e item do revisor creditado a quem o incluiu.
- Amostra `.data/legal-reports-sample/R1-exemplo.pdf` (10 páginas, pendente de revisão) e `R1-exemplo-aprovado.pdf`, regeradas depois das correções e renderizadas página a página (pdf.js no Chrome sem interface, `png/r1v2-p*.png`) e conferidas visualmente. As telas novas (cartão do R1 na ficha, formulário "Gerar R1") foram conferidas só por renderização no servidor nos testes, não num navegador.

**Rodada anterior (P0, P1, automação, Power BI e desinche da P0.6), 12/10/2026, ainda sem commit**

- `npx tsc --noEmit -p .`: sem erros.
- `npx vitest run` (PGlite): 161 arquivos, 1.553 testes; 1.548 passam, 3 são pulados e **2 falham**, ambos por expectativa antiga em teste, não por erro de execução:
  - `tests/intake/intake.test.ts` ("simulateIncomingProcess (demo)") espera valor da causa no cadastro; desde a P0.6 o valor da causa informado por quem não confere valores entra como **proposto** e o cadastro fica sem valor até a conferência;
  - `tests/fixes/briefs-work-forms/link-options.test.ts` espera o corte antigo de 1.000 processos nas listas de vínculo; desde a P0.6 `listProcessOptions` devolve todos os processos visíveis.
- `next build` e `next dev` **não** foram executados nesta rodada (vários trabalhos paralelos compartilham `.next/`). O último build de produção registrado é o do commit `fe5564b`.
- As telas alteradas na P0.6 (ficha do processo, carteira, painel, cabeçalho, textos) foram conferidas por **renderização estática no servidor** (`react-dom/server` com sessão simulada e o CSS do Tailwind compilado) e capturas do Chrome sem interface em 1440 e 390 px (`.data/p06-shots/`). **Nenhuma tela foi usada num navegador com o servidor real**: interação (diálogos, menus, abas no celular, seleção em lote), navegação no cliente e atalhos de teclado não foram exercitados.
- Integrações externas:
  - **DataJud**: o código consulta a API pública real quando `DATAJUD_API_KEY` está definida; os testes usam um provedor falso (`src/server/integrations/courts/fake.ts`). Uma coleta de ponta a ponta contra o CNJ não foi registrada nesta revisão.
  - **Power BI**: testes com Power BI simulado. O ponto de controle do projeto registra um teste de conexão com credenciais de teste no ambiente de desenvolvimento; esta revisão não o repetiu, e nenhum relatório real foi publicado nem exibido no Praetor por ela.
  - **Banco Central (SGS)**: os códigos das séries foram conferidos no serviço do SGS em 12/10/2026 pela frente dos índices; a carga demo chama a API real uma vez (falha de rede é registrada e a carga continua).
- Banco de desenvolvimento: recriado em UTF-8 (pt-BR); o antigo, em WIN1252, ficou como `praetor_win1252_antigo` ([OPERATIONS.md](OPERATIONS.md#migrar-o-banco-local-para-utf-8)). Esta revisão não consultou o banco de desenvolvimento.

**v2 integrada (commits `caaf9ad`, `fe6121f`, `fe5564b`)**: `tsc`, ESLint, 742 testes e `next build` sem erros, registrados no commit `fe5564b`.

**v1 (histórico)**: `npm run validate` completo (267 testes na época) e teste de fumaça no servidor de produção com os 7 perfis demo.

## Resumo

| | O que é |
|---|---|
| **Implementado (operacional)** | Carteira por número CNJ com fase e instância separadas, filtros da planilha, exportação CSV/Excel e saída da carteira ativa; ficha do processo em 6 abas com a faixa "Exige decisão agora"; importação da planilha com relatório de inconsistências, desfazer e distribuição em segundo plano; valores com histórico (nada é sobrescrito), fila de conferência, garantias e exposição líquida, classificação de risco, **pedidos do processo com risco derivado**, **valor atualizado por índice** (calculado na leitura), provisão, acordos, fechamento mensal imutável com **bloqueio por processo sem classificação** e **memória de cálculo em XLSX e PDF**; **coleta automática no DataJud** (movimentações, capa vazia, alertas); **API de entrada** com chaves; **painéis Power BI** com segurança por usuário; motor dos **relatórios jurídicos em PDF** com aprovação e versões e o **Relatório de Processo (R1)**, gerado automaticamente; audiências e alertas; regras de distribuição; pipeline de entrada; revisão da análise preliminar; relatórios CSV/XLSX; empresas, escritórios, oito perfis, auditoria exportável; painel executivo; busca global. |
| **Simulado (demonstrativo)** | Geração da análise preliminar (regras determinísticas, **sem IA**); entrega de e-mails (**nada é enviado**); chegada simulada de processo, manual ou pela rotina `simulated_feed` (só em organização de demonstração, **desligada** por padrão); documentos fictícios; valores extraídos pela simulação; sugestões preventivas ilustrativas; "pedidos recorrentes". A Central de IA da v1 roda em modo demonstrativo sem chave de API. |
| **Pendente** | MNI, painel de acervo do PJe, consulta pública dos TRTs e diário eletrônico (**não integrados**); envio real de e-mail; IA real na análise preliminar; OCR; ERP e RH; geradores dos relatórios jurídicos R2 a R4; fechamento mensal automático; tema escuro; uso no navegador com o servidor real. |

## Implementado por módulo

### Perfis, permissões e visibilidade

- **Oito perfis**: administrador, gestor jurídico, advogado, analista, executivo (diretoria), contabilidade, auditoria e escritório externo. Matriz em [SECURITY.md](SECURITY.md#matriz-de-permissões) e em Administração, Permissões (gerada do código).
- Permissões novas desta rodada: `report:generate` (gerar relatórios jurídicos em PDF: administrador, gestor, advogado e contabilidade; o tipo de relatório ainda limita os papéis) e `court_sync:run` (consultar o DataJud e sincronizar um processo: administrador, gestor, advogado e analista).
- Escritório externo vê só os processos do próprio escritório e os registros em que é responsável ou criador; listas de pessoas (responsáveis de processos, audiências, prazos e tarefas) mostram só o próprio escritório, o próprio usuário e os responsáveis pelos processos que ele vê; a carteira esconde os filtros "Unidade" e "Escritório externo" para esse perfil.
- Valores e risco: valores lançados só viram oficiais com `contingency:approve` e uma pessoa identificada; classificação de risco oficial exige `contingency:write` e pessoa identificada; fechar a competência exige `snapshot:close`.
- Valor da causa (P0.6): quem tem `contingency:approve` grava valor oficial; os demais (advogado, escritório externo, analista pela entrada) geram um valor **proposto** que vai para a conferência, e o cadastro mantém o valor anterior (ou fica "Não informado") até a aprovação. Só quem confere valores remove o valor da causa.
- Registro de acesso a processo sigiloso (no máximo um por usuário, processo e hora) e, na aba "Documentos e análises", a lista de downloads de documentos sensíveis do processo (quem baixou e quando), para quem vê esses documentos.

### Identidade visual, navegação e busca

- Logo e paleta navy e dourado (sem mudanças nesta rodada); menu agrupado por área e filtrado por permissão, com os itens novos "Consulta ao DataJud", "Relatórios jurídicos (PDF)" e "Painéis Power BI".
- Cabeçalho (P0.6): busca global, sino com o total de alertas (a contagem de críticos fica dentro do painel do sino) e **um** selo "Simulações" que lista o que é simulado no ambiente (análise preliminar, e-mails, IA sem chave), com links conforme a permissão.
- Faixa de demonstração em uma linha ("Ambiente de demonstração: dados fictícios. Análise preliminar e e-mails são simulados.") com "Saiba mais".
- Textos (P0.6): sem travessão; sem códigos internos (RN, RF, TE) na interface; "Pendente de conferência" no lugar de "Marcado para verificação"; valores "apurados" e "estimados" (o status "Oficial" de uma valoração continua sendo o resultado da conferência).
- Busca global (`/busca`): processos, documentos (sem buscar o conteúdo), contratos e ocorrências, cada seção com a própria permissão.

### Painel executivo (`/dashboard`)

Três blocos (P0.6):

1. **Exige decisão agora** (P0.1): audiências dos próximos 7 dias, prazos fatais (prazos processuais e regulatórios reais até 7 dias, vencidos incluídos; os sugeridos aguardando validação aparecem à parte), parcelas de acordo a vencer, garantias sem movimentação e valores pendentes de conferência. Cada bloco traz a contagem, até 5 itens e o link para onde se age. "Ver lista completa (N)" abre uma lista com os mesmos N itens; para prazos o link é "Ver prazos em aberto", sem contagem. Item ligado a registro que o usuário não vê aparece como "Registro sem acesso". Garantias paradas abrem a nova lista `/contingencias/garantias`.
2. **Carteira de passivo**: **exposição líquida** no topo (P1.8: valor apurado vigente menos garantias vinculadas, nunca negativa, com o detalhe do que foi abatido por tipo de garantia e os maiores processos; a exposição estimada aparece separada, rotulada "Estimado"); indicadores com a cobertura do valor apurado (P0.2: "valor apurado em X de Y processos", nunca "R$ 0" para não apurado); comparação com o fechamento anterior (itens guardados da competência fechada); "Pendências de cadastro" com link para `/processos?pendencia=…`; **um** gráfico "Exposição e processos por dimensão" com abas (tribunal, instância, fase, cidade, empresa, unidade; P0.3) e uma única unidade monetária por gráfico; maiores exposições.
3. **Mais indicadores**, recolhido por padrão: entradas e pendências (entrada de processos, alertas, análises preliminares a revisar), operação jurídica do período e acompanhamento. "Como ler este painel" virou um ícone de ajuda.

As contagens de alertas usam a mesma regra da central de alertas (permissão de leitura do módulo e visibilidade do registro); análises preliminares substituídas por versão mais nova não contam como "aguardando revisão".

### Carteira de processos (`/processos`)

- Uma linha por processo (P0.6): número CNJ, autor ("+N" quando há mais), tribunal e instância, cidade/UF, fase, valor da causa, valor apurado ("Não apurado" em cinza) e responsável ou escritório; a empresa só aparece quando a organização tem mais de uma empresa ativa. Em telas estreitas, um cartão por processo.
- Resumo com 4 números: processos (CNJ únicos), valor da causa e valor apurado lado a lado (com quantos estão sem valor apurado) e pendentes de conferência. "Mais filtros" fica recolhido, a não ser que um filtro avançado esteja ativo.
- Filtros da planilha (tribunal, instância, cidade, UF, empresa, escritório, classe, faixa de valor, liquidado com ou sem valor, pendência de cadastro, pendentes de conferência), recorte ativa/encerrada/todas, ordenação, paginação no servidor e exportação CSV e Excel (`/api/processes/export`, até 20.000 processos, aba consolidada e uma por instância, CPF/CNPJ mascarados).
- **Fase e instância são eixos distintos (P0.5)**: fase = Conhecimento, Liquidação ou Execução; instância = 1º, 2º ou 3º grau. "Em recurso" é instância, encerramento é situação. O banco recusa outras fases (CHECK). As fases antigas só aparecem em registros históricos.

### Ficha do processo (`/processos/[id]`)

- **Seis abas** (P0.6): Resumo, Partes e andamento, Valores e acordos, Prazos e audiências, Documentos e análises, Histórico. Os endereços antigos (`?aba=valores`, `?aba=audiencias`…) continuam abrindo a aba que tem o conteúdo, na seção certa.
- Cabeçalho: número CNJ como título, "Autor × Empresa" abaixo, selos; só "Editar" fica visível, e as demais ações (retirar ou reativar na carteira, marcar ou concluir conferência, excluir) ficam em "Mais ações".
- **Resumo**: a faixa "Exige decisão agora" do processo (P0.4: pendências, próximo ato, valores aguardando conferência, risco em vigor e responsável, cada item com link para onde se age) e a capa compacta (só campos preenchidos; valor da causa e valor apurado lado a lado; um único "Completar cadastro (N campos)").
- **Partes e andamento**: partes, instâncias e **uma** linha do tempo com as movimentações de todas as instâncias do mesmo CNJ (selo de instância e de origem: DataJud, importada ou manual) e o painel do DataJud ("Sincronizar agora").
- **Valores e acordos**: valores e risco (com "Informar índice" / "Trocar índice" e a exposição líquida com as garantias abatidas), **pedidos do processo**, acordos e **cenários** (propostas de faixa de probabilidade para os relatórios jurídicos).

### Importação de planilhas (`/importacoes`)

- Análise antes de gravar, inconsistências por linha (CSV), divergências entre abas viram valores propostos, confirmação em uma transação, reimportação idempotente e desfazer enquanto nada do lote mudou e nenhum processo entrou em competência fechada.
- A distribuição após a confirmação agora roda **em segundo plano** (job `import.distribute`, em blocos de 100 processos com progresso auditado por bloco); uma distribuição interrompida pode ser retomada pela tela.
- Fase da planilha (P0.5): vem só de Conhecimento, Liquidação e Execução/Cumprimento; recurso, agravo, ROT e AIRO indicam o 2º grau e TST, RR e AIRR o 3º grau, marcando o processo para conferência.

### Contingências, pedidos e índices (`/contingencias`, `/acordos`)

- **Valores com histórico** (proposto, oficial, substituído ou rejeitado), revisor identificado, conferência em lote só acima do limiar de confiança e nunca para extração simulada ou quitação. Espelhos no processo atualizados na mesma transação. Remover o valor da causa grava a data em que ele deixou de valer (`cleared_on`), para a posição em datas passadas.
- **Quitação** (extinção pelo pagamento): nova valoração de liquidado igual a zero; o resultado informa se o valor em vigor foi zerado, se já era zero ou se ficou proposto.
- **Garantias** e **exposição líquida** (P1.8): só garantias vinculadas abatem; a lista do que foi abatido aparece na aba de valores e no painel.
- **Pedidos do processo (P1.6)**: pedidos com valor, data-base e índice; avaliação de risco por pedido (só inserção); a classificação do processo é **derivada** dos pedidos (a pior classificação; provisão = soma de base × percentual dos pedidos quantificados) e gravada como nova classificação oficial, com data de vigência igual à da avaliação de pedido mais recente que conta (uma avaliação retroativa dentro da competência vale para o fechamento dela). Pedido sem valor nunca vale zero: com pedidos quantificados e não quantificados misturados, a classificação usa o percentual da organização e é marcada para revisão. Classificação manual diferente da derivada exige justificativa e é mantida, com alerta quando os pedidos mudam. O histórico de risco rotula "Derivada dos pedidos". A análise preliminar pronta sugere pedidos (pendentes de confirmação, nunca contam antes de uma pessoa confirmar).
- **Índices de correção (P1.7)**: IPCA-E, IPCA, INPC, Selic e TR coletados automaticamente da API pública do Banco Central (rotina diária e "Atualizar agora"). Cada valoração tem o seu índice (novos valores recebem o padrão da organização, "nenhum" por padrão). O **valor atualizado é calculado na leitura e nunca gravado**, sempre ao lado do valor original e nunca somado a totais. Mês faltando na série deixa o valor "indisponível" com os meses listados (nada é estimado). Trocar o índice de um valor oficial cria um novo registro oficial (o anterior fica no histórico) e é recusado quando mudaria o valor em vigor. A fila de conferência mostra o índice e o valor atualizado e recusa a aprovação se o índice mudou depois que a tela abriu. Cartões em Administração, Configurações (índice padrão) e Integrações (séries).
- **Fechamento mensal com bloqueio (P1.9)**: a competência só fecha sem ressalva quando todo processo da prévia tem classificação de risco oficial em vigor na data-base. Com pendências, "Fechar com justificativa" (mínimo de 20 caracteres) grava a ressalva com a lista de processos. Prévia desatualizada (classificação registrada depois do cálculo, processo excluído, encerrado ou incluído, fase ou instância alterada) precisa ser recalculada antes de fechar, mesmo com justificativa. A rotina nunca fecha e abre o alerta "Processo sem classificação de risco impede o fechamento mensal".
- **Memória de cálculo da provisão (P1.10)**: em `/contingencias/provisao`, XLSX e PDF gerados dos itens guardados da competência (mesmos números nos dois), com base aplicável, garantias, classificação e sua origem (manual, derivada dos pedidos, sugestão por regra, importada, cadastro), parecer e responsável em vigor no cálculo, totais por empresa e classificação e a lista completa de processos da ressalva. Total sem nenhum valor aparece como "Sem provisão" (PDF) ou célula vazia (XLSX), nunca R$ 0,00. Acima de 3.000 processos só o XLSX. Download auditado.
- Fila de conferência, sugestão de risco por regra (sempre proposta), acordos com parcelas e garantias paradas em `/contingencias/garantias` (P0.6).

### Relatórios jurídicos em PDF (`/relatorios-juridicos`)

- **Motor** implementado: modelo de dados (relatório, itens com origem obrigatória, fontes conferidas, cenários), numeração sequencial por organização, tipo e ano sem buracos, emissão com validação (item de cadastro sem data ou documento sem hash bloqueia a emissão), conferência das fontes documentais (documento visível, versão, hash, página e trecho literal), pendências do relatório, PDF no servidor (fontes embutidas, cabeçalho, rodapé "Página X de Y", marca d'água até a aprovação), aprovação por pessoa com o papel do tipo, novas versões e download auditado com conferência do hash. O banco recusa alterar relatório emitido e excluir relatórios.
- **Relatório de Processo (R1)** implementado (referência R1-ano-número, uma por processo; gerar de novo cria a versão seguinte):
  - seções: 1 capa de identificação (referência, data-base, matéria, autos de origem e recursais com as instâncias, partes sem CPF/CNPJ, empresa, responsável, finalidade, base legal, "Elaborado por" com a versão do sistema e "Revisado por" vazio até a aprovação); 2 nota metodológica **gerada dos dados** (documentos examinados e não examinados, valorações, pedidos, garantias, movimentações, cenários, lacunas, conferência das fontes e minimização); 3 síntese executiva (3 a 6 pontos com selo de origem); 4 linha do tempo única (cadastro, DataJud e eventos extraídos de documentos com página, em tabela com o selo de cada linha); 5 quadro de pedidos (valor pleiteado original, valor apurado, data-base, índice, valor atualizado calculado na leitura ou "atualização indisponível", risco e percentual) e, separados, valor da causa e valor apurado do processo; 6 garantias e exposição líquida (o que foi abatido; a estimativa aparece separada como "Estimado"); 7 matriz de cenários com a ressalva fixa; 8 pontos de atenção (próximo ato, prazos, audiências, valores aguardando conferência, conferência pendente, alertas, itens da análise preliminar); 9 auditoria de fontes (Verificado e Não confirmado, com a regra de que fonte não confirmada nunca é base); 10 pendências do relatório (itens não afirmados e a lista dos dados não localizados);
  - a análise preliminar (simulação nesta versão) entra pela proveniência: extraído vira Documentado (trecho conferido na página), cadastro vira Cadastro, lacuna vira Lacuna (de **todas** as seções: lacunas de informação, identificação, valores, pedidos, argumentos, documentos faltantes e linha do tempo; as que citam o cadastro só não são repetidas quando tratam, por inteiro, de um dado que o R1 lê, reconhecido pela chave do campo ou pela frase fixa inteira da simulação, nunca por palavra-chave: se o dado ainda falta, o R1 marca a própria lacuna dele; se já consta da base, a lacuna da análise "não se aplica mais"; lacuna sobre dado que o R1 não lê, em texto livre ou incluída ou editada pelo revisor entra como as demais), ilustrativo vira Análise marcada como "Simulação" (só nas seções 3 e 8), item do revisor vira Análise creditada a quem o incluiu, com a data da revisão em que entrou (histórico de revisões). Documento de saúde é só referenciado (o texto do item não reproduz o conteúdo e o trecho não é gravado) e o R1 que o cita só aparece para quem pode vê-lo;
  - **lacunas completas**: todo dado não localizado é item de lacuna ou célula vazia de tabela (ex.: Cidade/UF de uma instância, data-base de um pedido, data de um evento) e aparece na lista "Dados não localizados" da seção 10; a nota metodológica conta pela mesma regra. Marcador no texto de um item que não é lacuna só repetindo uma lacuna listada (a emissão é bloqueada se não houver). O ponto de lacunas da síntese é Inferência, derivado dos itens de lacuna que cita; "sem registros encontrados" só aparece em consulta vazia;
  - síntese 3.1 com o tribunal e o órgão julgador da **instância atual** (antes repetia os da origem, que a coleta do DataJud grava no cadastro do processo); a capa traz a fase processual e tribunal e vara / órgão julgador separados (a vara que falta é lacuna própria, mesmo com o tribunal conhecido);
  - parecer da classificação de risco (6.2, Análise) **inteiro**, nunca cortado no meio de uma frase; acima de 3.000 caracteres é resumido em fim de frase, com a indicação de que foi resumido e de onde está o texto completo;
  - **sem CPF nem CNPJ**: textos livres (títulos de movimentações e alertas, notas, textos da análise) passam pela omissão ("[CPF omitido]", "[CNPJ omitido]"; formato usual, número depois da sigla ou 11/14 algarismos com dígitos verificadores válidos) e trecho de documento com esses números não é citado;
  - **visibilidade pelo conteúdo**: o R1 só aparece para quem tem as permissões de leitura de tudo o que ele traz (análise preliminar, prazos, valores), além do processo e dos documentos citados. A diretoria e a contabilidade não veem um R1 com a análise preliminar; a contabilidade não vê um R1 com prazo em aberto ("Prazos em aberto: nenhum registrado" não conta como conteúdo de prazos);
  - **escritório externo**: consulta e baixa o R1 dos processos do seu escritório (permissão nova `legal_report:read`, separada de `report:read`, que continua fechada para ele: relatórios gerenciais e Power BI), sem gerar nem aprovar;
  - sem cenário registrado, o sistema **propõe** cenários a partir das avaliações dos pedidos (um por pedido avaliado, na faixa configurada que contém o percentual), rotulados "Proposta do sistema, sujeita a revisão". A montagem do relatório não grava nada: as propostas são gravadas (só inserção) na mesma transação da emissão, e nada fica se a emissão falhar; a auditoria registra quem pediu a geração (ou a geração automática) e a referência do relatório;
  - **automação**: aprovar a análise preliminar enfileira a geração do R1 pelo sistema (job `legal_report.generate`, depois da aprovação e sem afetá-la); a rotina diária `legal_reports_refresh` gera a versão seguinte (pendente de revisão) só quando os dados do processo mudaram (impressão digital gravada no R1) e **nunca substitui um R1 aprovado**: abre o alerta "Relatório do processo (R1) aprovado desatualizado", encerrado quando uma pessoa gera a nova versão;
  - botão "Gerar R1" na aba "Documentos e análises" do processo e em `/relatorios-juridicos`; com R1 aprovado, só o gestor jurídico ou o advogado responsável geram a nova versão.
- O **"Documento de teste do motor"** continua disponível (numeração própria TESTE-R1-ano-número, que não consome a numeração oficial). Os geradores R2 a R4 estão pendentes.
- Amostra do R1 com dados fictícios: `LEGAL_REPORT_SAMPLE_OUT=.data/legal-reports-sample npx vitest run tests/legal-reports/r1/sample.test.ts` grava `R1-exemplo.pdf` e `R1-exemplo-aprovado.pdf` (as taxas de índice dessa amostra são valores de teste, não as publicadas pelo Banco Central).
- Parâmetros (limiar de confiança, faixas de probabilidade, texto de fundamentação) em `/relatorios-juridicos/parametros`.

### Coleta automática no DataJud (CNJ)

- Rotina `court_sync` (de hora em hora): consulta em lote, por tribunal de origem, os processos da carteira ativa cuja vez chegou (intervalo por processo, 24 h por padrão; depois de falha, espera 1 h, 2 h, 4 h…), respeitando o limite de consultas por minuto de cada tribunal. Números com dígito verificador inválido não são consultados.
- Grava numa transação por processo, com o ator "Sistema · DataJud" na auditoria: vínculos de instância, **só movimentações novas** (sem duplicar), **só campos vazios** da capa (órgão julgador, classe, cidade/UF, ajuizamento), os assuntos informados pelo tribunal e a data da última movimentação, mudanças de fase só quando inequívocas e para frente. Divergência com o cadastro vira nota de conferência uma vez (não volta depois que alguém concluiu a conferência). Trânsito em julgado, baixa, arquivamento e extinção viram alerta e pendência de conferência, **nunca encerramento automático**. Audiência designada vira alerta para cadastrar a data (o DataJud não informa a data). O DataJud não informa partes, valores nem documentos.
- "Sincronizar agora" na ficha (`court_sync:run`), consulta avulsa sem gravar em `/consulta-datajud`, "Sincronizar a carteira agora" e saúde da coleta por tribunal em Administração, Integrações, DataJud (última execução, consultados, encontrados, falhas, processos aguardando). Três execuções falhas seguidas de um tribunal, ao longo de 2 h ou mais, abrem um alerta crítico.
- Sem `DATAJUD_API_KEY`, tudo mostra "Coleta inativa" e nada quebra.

### API de entrada de processos (`/api/v1`)

- `POST /api/v1/processos` (escopo `intake:create`): sistemas externos enviam processos novos com partes e documentos (PDF, DOCX e TXT em base64, conferidos pela assinatura). Número já cadastrado não duplica: os documentos são anexados ao processo existente. Número novo segue o mesmo fluxo da entrada manual (distribuição, análise preliminar simulada, e-mail simulado), com enriquecimento opcional pelo DataJud (só campos vazios). Idempotência por `Idempotency-Key`; limite de 60 requisições por minuto por chave.
- `GET /api/v1/processos/{numero}` (escopo `process:read`): situação de um processo recebido pela API da mesma organização. Contrato OpenAPI em `GET /api/v1/openapi.json`; guia em [API.md](API.md).
- Chaves criadas e revogadas em Administração, Integrações, API de entrada (mostradas uma única vez; o banco guarda só o hash), com o registro das requisições das últimas 24 h. `scripts/demo-api-push.ts` faz o papel de um sistema externo fictício.

### Painéis Power BI (`/paineis-bi`)

- Camada de leitura governada no banco (schema `bi`, só visões, sem nomes de partes, CPF/CNPJ de pessoas nem texto de documentos; valor da causa e valor apurado em colunas separadas; nulo não é zero; competências só depois de fechadas).
- Usuário de banco somente leitura por organização (`scripts/bi-setup.ts`), visões com barreira de segurança, tabela de acessos por usuário calculada com as mesmas regras de visibilidade das telas e token de incorporação de 20 minutos, somente leitura, em nome do usuário (segurança por linha no Power BI).
- Rotina `bi_access_refresh` (de hora em hora): recalcula os acessos e pede a atualização do conjunto de dados quando há motivo (importação, fechamento, coleta com novidades, mudança de acessos ou uma vez por dia), com intervalo mínimo e limite diário. Configuração, teste de conexão e histórico em Administração, Integrações, Power BI. Guia completo em [POWER_BI.md](POWER_BI.md).

### Audiências e alertas (`/audiencias`, `/alertas`)

- Audiências cadastradas por pessoas, resultado, redesignação com histórico e cancelamento. Alertas e lembretes por e-mail simulado só para processos da carteira ativa (ativos ou suspensos); alertas de processos que saíram dela são encerrados.
- Painel de alertas com 9 áreas. Tipos novos: movimentação relevante, audiência designada no tribunal e falha da coleta (DataJud), classificação de risco a rever (pedidos) e processo sem classificação que impede o fechamento. **Cada alerta abre a aba do seu próprio tipo**, mesmo quando o processo tem vários alertas.

### Entrada de processos, distribuição, análise preliminar e e-mails

- Pipeline da entrada (registro, responsável, análise preliminar simulada, e-mail simulado, revisão, aprovação), agora também com origem "Recebido por API" e "Chegada simulada". Regras de distribuição, redistribuição com motivo e painel de carga (análises substituídas não contam).
- E-mails simulados em uso: análise pronta (`case_brief_ready`), atribuição de responsável (`intake_assigned`, quando "Avisar quando um processo for atribuído" está ligado), lembrete de audiência (`hearing_reminder`) e resumo diário pelo botão (`daily_digest`; versões substituídas de análise não entram).

### Administração

- Empresas, escritórios, usuários com os oito perfis, matriz de permissões, auditoria com exportação CSV, parâmetros de contingência versionados (com o índice padrão), e-mail e entrada, rotinas.
- **Integrações** (`/admin/integracoes`): situação honesta de cada integração (DataJud operacional quando configurado; MNI, PJe, TRTs e diários não integrados; análise preliminar e e-mail simulados), fila, rotinas, importações, séries de índices e as páginas DataJud, API de entrada e Power BI.
- Auditoria: quem tem `audit:read` sem ver sigilosos (auditoria) recebe as entradas de prévia e fechamento de competência que incluem processo sigiloso com o resumo oculto, porque elas trazem totais da organização.

### Funcionalidades da v1 que continuam

Jurídico preventivo, contratos, documentos (upload validado, versões, download autenticado, retenção legal), prazos e tarefas com validação humana de sugestões, comentários, Central de IA (`/ia`), fila de jobs e worker, rotinas, login com sessões opacas, equipes e unidades.

## Simulado / demonstrativo

- **Análise preliminar**: `SimulatedCaseBriefProvider`, regras determinísticas sobre o cadastro e o texto dos documentos, **sem inteligência artificial**. Toda tela mostra o aviso e o selo de proveniência de cada item. Os pedidos sugeridos a partir dela entram como sugestão pendente de confirmação.
- **E-mails**: `SimulatedEmailProvider`, nenhuma conexão de rede; assunto com "[Simulação]".
- **Chegada simulada de processos**: botão "Simular chegada de processo" e rotina `simulated_feed` (uma chegada fictícia por intervalo, só em organização de demonstração e só quando ligada nas configurações; vem desligada).
- **Documentos fictícios**, **valores extraídos pela simulação** (rotulados "Extração simulada (demonstração)", nunca aprovados em lote), **sugestões preventivas ilustrativas** e **"pedidos recorrentes"** (contagens das análises simuladas).
- **Central de IA (v1)**: sem `ANTHROPIC_API_KEY`, modo demonstrativo rotulado.
- **Dados de demonstração**: organizações, pessoas, empresas, escritórios e números de processo fictícios; a planilha `scripts/seed-data/files/Passivo_TESTE_Consolidado_DADOS_FICTICIOS.xlsx` foi fornecida pelo cliente com dados fictícios. A carga demo também cria pedidos avaliados de 20 processos, cenários de 4 processos e uma chave de API de demonstração (mostrada uma vez na saída da carga); ela não chama o DataJud.

## Pendente

**Integrações**

- MNI, painel de acervo do PJe, consulta pública dos TRTs e diário eletrônico (DJEN/DEJT): **não integrados**. Não há captura de publicações e intimações, de partes nem de valores pelo tribunal; detecção de processo novo contra a empresa depende da API de entrada (o DataJud só consulta números já cadastrados).
- Envio real de e-mail e preferências por usuário; resumo diário agendado (hoje só pelo botão); mensageria.
- IA real da análise preliminar (adaptador `LiveCaseBriefProvider` existe, **não é selecionável**).
- OCR; integração com ERP/contabilidade e com folha/RH.

**Funcionalidades**

- Geradores dos relatórios jurídicos R2 a R4. No R1: o módulo de pedidos não registra valor apurado por pedido (a coluna mostra "Não apurado"); a omissão de CPF e CNPJ cobre os formatos usuais e números com dígitos verificadores válidos, não números escritos de forma irregular (ex.: com espaços no meio); a diretoria e a contabilidade não veem o R1 quando ele traz a análise preliminar (ou prazos, para a contabilidade), porque o relatório é um só para todos os perfis (não há versão reduzida por perfil).
- Valor atualizado dos **pedidos** no painel de pedidos (o índice é guardado e o R1 já calcula a atualização na geração, mas o painel do processo ainda não mostra) e escolha do índice no formulário de novo valor (hoje o valor recebe o índice padrão e quem confere troca depois).
- E-mails `deadline_reminder` e `brief_approved` não são enviados por nenhum fluxo.
- Fechamento mensal automático no fim do mês (a rotina só atualiza a prévia e abre alertas).
- Carta de auditoria em data-base arbitrária; limites dos indicadores preventivos configuráveis.
- Importação: mapeamento UF para unidade na interface, edição manual do mapeamento de colunas, atualização de partes de processos existentes, desfazer parcial.
- Exclusão de audiências; registro de procuração e bloqueio de acesso quando o patrocínio cessa; edição de prazos e tarefas pela interface; busca no conteúdo dos documentos fora da Central de IA.
- Tema escuro.

**Operação e segurança**

- Uso de todas as telas no navegador (desktop e celular) com cada perfil demo e teste de fumaça no servidor de produção com o worker.
- Coleta real de ponta a ponta no DataJud e publicação real de um relatório no Power BI, acompanhadas por quem mantém o sistema.
- Validar em PostgreSQL real a emissão concorrente da numeração dos relatórios jurídicos (o teste roda no PGlite, que tem uma conexão só).
- Backup diário automatizado e testes de restauração periódicos; bootstrap de organização para produção, recuperação de senha, MFA e SSO, limitação de tentativas compartilhada e os itens de [SECURITY.md](SECURITY.md#o-que-ainda-precisa-ser-avaliado-antes-de-uso-em-produção).

## Decisões de produto registradas

Tomadas durante a construção, com autorização para seguir sem consulta; as marcadas "a confirmar" esperam a palavra do responsável pelo produto.

- Pedido sem valor nunca vale zero: com pedidos quantificados e não quantificados misturados, o risco derivado usa o percentual da organização e é marcado para revisão (a confirmar: a alternativa é não gravar nada até todos os pedidos terem valor).
- A provisão oficial segue a regra base aplicável × percentual do processo, e o percentual vem dos pedidos; o painel de pedidos mostra também a soma pelos pedidos quando ela difere (a confirmar: qual das duas prevalece).
- A classificação derivada dos pedidos vale a partir da data das avaliações dos pedidos; "aplicar classificação derivada" que encerra uma classificação manual vale a partir do dia em que é registrada.
- Fechamento mensal de demonstração: com processos sem classificação, a carga demo fecha os meses anteriores com justificativa registrada.
- Audiências de processos fora da carteira ativa não geram alerta nem lembrete.
- A provisão estimada (base = valor da causa) continua sem abater garantias, enquanto a exposição estimada abate (a confirmar).
- Trocar o índice de um valor oficial é recusado quando outra instância tem valor oficial na mesma data-base (proteção conservadora: o botão aparece, e a pessoa recebe a recusa).
- Classificação oficial registrada fora do painel de pedidos depois da primeira avaliação de pedido é tratada como decisão humana e mantida, mesmo quando era igual à derivada (a confirmar).
- Garantia "sem movimentação" conta a partir de N dias ou mais (`idleGuaranteeDays`), igual na rotina, no painel e na lista (a confirmar o limite exato).
- Memória de cálculo: perfis com visão da organização inteira e `snapshot:close` (contabilidade) recebem totais por empresa que incluem processos sigilosos não listados, com o aviso "inclui N sigilosos" (ver [SECURITY.md](SECURITY.md)).

## Limitações conhecidas

**Carteira, ficha e importação**

- Exportação limitada a 20.000 processos por arquivo; autor e réu exibidos são a primeira parte de cada polo.
- Alterar o valor da causa (por quem confere valores) substitui as valorações oficiais de causa do processo, de qualquer instância.
- RN-06 não é aplicado automaticamente na importação; processos que aparecem só nas abas de 2º/3º grau mantêm os polos como escritos lá (sinalizado).
- O desfazer da importação detecta "alterado depois" por auditoria, registros filhos e `updatedAt`; diferença de relógio entre aplicação e banco poderia gerar um falso "alterado".
- Migração `0012_phase_instance_split`: processos com fase antiga sem instância recursal conhecida ficaram pendentes de conferência; prévia calculada antes da migração precisa ser recalculada. A API de entrada recusa as fases antigas com 400.

**Contingências, pedidos, índices e relatórios**

- "Processo ativo na data-base" é derivado de situação, `closedAt` e `filedAt`; encerrados sem `closedAt` ficam fora de todas as competências.
- Instâncias diferentes mantêm valores oficiais separados do mesmo tipo; o espelho usa a data-base mais recente entre instâncias. Por isso valores de instâncias diferentes com a mesma data-base nunca têm o índice trocado.
- A classificação guardada só no cadastro (sem histórico oficial) é congelada como está quando entra numa competência fechada com ressalva.
- O aviso de provisão do processo diferente da provisão pelos pedidos pode aparecer também em processo sem nenhum pedido (o serviço trata a ausência de provisão pelos pedidos como diferença).
- O alerta de revisão dos pedidos só é reavaliado na próxima ação do módulo de pedidos: uma classificação registrada na aba de valores não o encerra sozinha.
- Comparações de horário entre registros (pedidos, prévia do fechamento) misturam o relógio da aplicação e o do banco; diferença grande de relógio pode gerar um falso "desatualizado" (resolvido recalculando).
- Relatórios de competência fechada aplicam a visibilidade **atual**; movimentação do período com 100 por página na tela e até 10.000 eventos na exportação; a impressão dos relatórios usa `:has()` (Chrome 105+, Safari 15.4+, Firefox 121+).
- Abrir diretamente `/api/provision-memo/<competência>?formato=pdf` acima de 3.000 processos devolve o erro em JSON da rota.
- O PDF dos relatórios jurídicos é gerado dentro da transação que trava a numeração: emissões do mesmo tipo e ano na mesma organização esperam alguns segundos em fila.

**Automação e Power BI**

- O limite de consultas por minuto ao DataJud e o limite de requisições da API de entrada ficam em memória, por processo (worker ou instância web).
- Alertas do DataJud consideram movimentações dos últimos 120 dias (um encerramento que seja a movimentação mais recente é apontado qualquer que seja a data).
- Power BI em modo Importar: uma mudança de acesso só chega ao painel na próxima atualização do conjunto de dados (no pior caso cerca de 24 h, se o limite diário foi usado). O isolamento por organização vale para as linhas; em banco compartilhado, metadados gerais do PostgreSQL continuam visíveis ao usuário de leitura ([POWER_BI.md](POWER_BI.md)).

**Entrada, análise preliminar e e-mails**

- O pipeline da entrada, a distribuição após importação, a coleta do DataJud, a atualização dos painéis e as séries de índices dependem do **worker**.
- As regras da análise simulada foram ajustadas aos documentos fictícios; documentos reais com outro formato produzem menos itens (aparecem como lacunas, nunca como conteúdo inventado).
- A entrega do e-mail é em duas fases ("Envio não concluído" até o provedor responder); links dentro da pré-visualização do e-mail não funcionam.

**Administração**

- Unicidade de CNPJ verificada pela aplicação, sem índice no banco; desativar um escritório não desativa os usuários dele.
- Exportação da auditoria limitada a 10.000 registros; o contador do sino atualiza depois de uma ação que revalida a página ou ao recarregar.

## Próximas etapas (por prioridade)

1. **Verificação no navegador e de ponta a ponta**: subir web e worker, percorrer cada tela com todos os perfis demo (desktop e celular), teste de fumaça no servidor de produção, coleta real no DataJud e um relatório real no Power BI.
2. **Decisões pendentes do produto** listadas acima (provisão oficial x soma dos pedidos, pedidos sem valor, provisão estimada e garantias).
3. **Geradores R2 a R4** dos relatórios jurídicos sobre o motor existente (o R1 está pronto).
4. **Base para produção**: bootstrap de organização e administrador, convite e recuperação de senha, limitação de tentativas distribuída, CSP nas páginas, backup automatizado com restauração testada.
5. **Integrações oficiais além do DataJud**: MNI e diários, após cadastro formal nos tribunais.
6. **E-mail real e IA real da análise preliminar**, cada um atrás da interface existente, após revisão de custos, contrato de tratamento de dados (LGPD) e rotulagem ([ADR-0010](adr/0010-simulated-integrations-behind-interfaces.md)).
