# Segurança

Este documento descreve os controles **implementados** nesta versão (v2) e os que ainda faltam.

> **Aviso importante.** O Praetor **não declara conformidade legal** (LGPD, sigilo profissional, normas setoriais ou outras) **nem segurança completa**. Os controles abaixo são uma base técnica. Antes de qualquer uso com dados reais é preciso fazer as avaliações listadas em [O que ainda precisa ser avaliado antes de uso em produção](#o-que-ainda-precisa-ser-avaliado-antes-de-uso-em-produção).

## Autenticação

- **Senhas**: argon2id (`@node-rs/argon2`, parâmetros padrão da biblioteca). A política mínima (`passwordPolicyError`) exige 10 caracteres, com letras e números. Senhas nunca são logadas nem auditadas.
- **Sessões opacas no banco** ([ADR-0005](adr/0005-db-sessions.md)):
  - o token tem 32 bytes aleatórios (base64url) e fica só no cookie; o banco guarda apenas o SHA-256 dele (`sessions.id`);
  - cookie `praetor_session` com `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` quando `APP_URL` começa com `https://`, e expiração de `SESSION_TTL_HOURS` (12 h por padrão);
  - a cada requisição a sessão é resolvida junto com o usuário: usuário inativo, sessão expirada ou organização divergente invalidam o acesso. Perfil, unidade e **escritório externo** (`users.law_firm_id`, v2) são relidos, então mudanças valem na próxima requisição;
  - "Sair" apaga a sessão no banco e o cookie (o cookie é removido mesmo se a revogação falhar). Desativação, troca de perfil, unidade ou escritório e redefinição de senha revogam todas as sessões do usuário;
  - sessões expiradas são limpas de forma oportunista a cada login.
- **Login**: mensagem genérica ("E-mail ou senha inválidos.") e verificação de hash simulada para e-mails desconhecidos (tempo de resposta parecido). O redirecionamento `?next=` passa por `safeNextPath`, que bloqueia open redirect.
- **Limitação de tentativas**: 5 falhas por e-mail + IP em 15 minutos. **É em memória, por processo**: com várias instâncias, ou após um reinício, o contador não é compartilhado (pendente: armazenamento compartilhado).
- Logins, falhas de login (de e-mails existentes) e saídas são auditados (`auth.login`, `auth.login_failed`, `auth.logout`).
- `src/proxy.ts` só redireciona quem não tem cookie. **Não é autorização.**

## Autorização

Duas verificações independentes, ambas obrigatórias em todo serviço:

1. **Permissão de ação**: `assertCan(ctx, perm)` (`src/server/auth/permissions.ts`).
2. **Visibilidade por linha**: o builder `*Where(ctx)` de `src/server/auth/access.ts` em **toda** consulta (listas, contagens, leituras unitárias, escritas). Leituras unitárias usam `id AND escopo` e devolvem `NotFoundError` sem revelar se o registro existe. Ver [ADR-0009](adr/0009-row-visibility-in-services.md).

Páginas chamam `requirePageContext(perm)`, ações `requireActionContext(perm)` e route handlers `getCurrentUser()` seguido de `can(ctx, perm)`. Esconder botões e itens de menu é só conveniência. Contextos de sistema (`systemContext(orgId)`, usados por jobs e rotinas) passam em toda permissão e veem toda a organização, mas continuam presos a uma única organização.

### Perfis (v2)

| Perfil | Id | Em resumo |
|---|---|---|
| Administrador | `admin` | Tudo, inclusive usuários, parâmetros e integrações. |
| Gestor jurídico | `legal_manager` | Toda a carteira (inclusive sigilosos), aprova valores, fecha competência, distribui demandas, importa planilhas, auditoria. Sem administração de usuários e organização. |
| Advogado | `lawyer` | Carteira da sua unidade e os casos sob sua responsabilidade; lança valores (como propostos), avalia pedidos e classifica risco; revisa análises preliminares; sincroniza com o DataJud; gera relatórios jurídicos R1 e R4. |
| Analista | `analyst` | Apoio: entradas de processos, documentos, prazos e tarefas da sua unidade; consulta o DataJud; não edita processos diretamente. |
| Executivo (diretoria) | `executive` | Consulta painéis (inclusive Power BI), relatórios e inteligência preventiva da carteira não sigilosa. |
| Contabilidade | `accountant` | Valores, garantias, risco, conferência de valores, provisão, memória de cálculo e fechamento mensal; gera relatórios jurídicos R2; não vê peças sigilosas. |
| Auditoria e compliance | `auditor` | Leitura da carteira não sigilosa, relatórios, análises preliminares, e-mails visíveis e trilha de auditoria. |
| Escritório externo | `external_counsel` | Só os processos atribuídos ao seu escritório (`users.law_firm_id`); sem unidade. |

### Matriz de permissões

Gerada a partir de `ROLE_PERMISSIONS` (também em **Administração, Permissões**). ✔ = tem a permissão; · = não tem.

| Permissão | Admin | Gestor | Advogado | Analista | Executivo | Contabilidade | Auditoria | Escritório externo |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `dashboard:read`, `process:read`, `document:read`, `contingency:read` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `occurrence:read`, `contract:read`, `analysis:read` | ✔ | ✔ | ✔ | ✔ | ✔ | · | ✔ | · |
| `task:read`, `deadline:read` | ✔ | ✔ | ✔ | ✔ | ✔ | · | ✔ | ✔ |
| `process:write` | ✔ | ✔ | ✔ | · | · | · | · | ✔ |
| `occurrence:write`, `contract:write`, `analysis:request` | ✔ | ✔ | ✔ | ✔ | · | · | · | · |
| `document:upload`, `task:write`, `deadline:write` | ✔ | ✔ | ✔ | ✔ | · | · | · | ✔ |
| `comment:write` | ✔ | ✔ | ✔ | ✔ | · | ✔ | · | ✔ |
| `process:delete`, `occurrence:delete`, `contract:delete`, `document:delete` | ✔ | ✔ | · | · | · | · | · | · |
| `deadline:validate`, `alert:resolve`, `analysis:review` | ✔ | ✔ | ✔ | · | · | · | · | · |
| `contingency:write` (lançar valores, garantias, risco, pedidos avaliados, acordos, cenários) | ✔ | ✔ | ✔ | · | · | ✔ | · | ✔ |
| `contingency:approve` (oficializar valores, trocar índice de valor oficial), `snapshot:close` | ✔ | ✔ | · | · | · | ✔ | · | · |
| `report:read` (relatórios gerenciais, exportações, painéis Power BI) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | · |
| `legal_report:read` (consultar e baixar relatórios jurídicos em PDF dos processos visíveis) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `report:generate` (gerar relatórios jurídicos em PDF para revisão) | ✔ | ✔ | ✔ | · | · | ✔ | · | · |
| `preventive_intel:read` | ✔ | ✔ | ✔ | ✔ | ✔ | · | · | · |
| `intake:manage` (registrar entrada de processos) | ✔ | ✔ | ✔ | ✔ | · | · | · | · |
| `court_sync:run` (consultar o DataJud e sincronizar um processo) | ✔ | ✔ | ✔ | ✔ | · | · | · | · |
| `brief:read` | ✔ | ✔ | ✔ | ✔ | · | · | ✔ | ✔ |
| `brief:review` | ✔ | ✔ | ✔ | · | · | · | · | ✔ |
| `email:read` | ✔ | ✔ | ✔ | ✔ | · | · | ✔ | ✔ |
| `email:send` (gerar envios simulados) | ✔ | ✔ | ✔ | · | · | · | · | · |
| `audit:read` | ✔ | ✔ | · | · | · | · | ✔ | · |
| `import:run`, `distribution:manage` | ✔ | ✔ | · | · | · | · | · | · |
| `admin:users`, `admin:organization` (inclui chaves de API, DataJud e Power BI) | ✔ | · | · | · | · | · | · | · |

Regras adicionais aplicadas nos serviços:

- Só admin e gestor jurídico marcam ou desmarcam `is_confidential` em processos, ocorrências e contratos. Um processo criado a partir de ocorrência confidencial herda a confidencialidade.
- Escritório externo só cadastra processos do próprio escritório e não pode mudar o escritório de um processo.
- Valores lançados por quem não tem `contingency:approve` (advogado, escritório externo) entram como **propostos**; oficializar (aprovar, corrigir) exige `contingency:approve` e uma pessoa identificada (RN-11). Conferência em lote só para propostas com confiança acima do limiar configurado, e nunca para extração simulada ou quitação.
- **Valor da causa no formulário do processo**: só quem tem `contingency:approve` pelo papel grava o valor como oficial (a pessoa fica como revisora). Os demais (advogado, escritório externo, analista pela entrada de processos) geram um valor **proposto** para a conferência, e o cadastro mantém o valor anterior (ou fica sem valor) até a aprovação. Remover o valor da causa exige quem confere valores. Sem pessoa identificada (rotinas, API de entrada), o serviço de processos recusa alterar o valor da causa de um processo existente; a importação de planilha grava os valores pelo próprio fluxo, com quem confirmou como revisor.
- Classificação de risco oficial, avaliação de pedidos, classificação derivada dos pedidos e aprovação ou rejeição de sugestões por regra exigem `contingency:write` e uma pessoa identificada; contexto de sistema não oficializa nada.
- **Índice de atualização**: em valor proposto, `contingency:write`; em valor oficial, só `contingency:approve`, sempre com novo registro (o anterior fica no histórico), recusado quando mudaria o valor em vigor. A conferência recusa aprovar um valor cujo índice mudou depois que a tela foi aberta.
- Gerar a prévia do fechamento mensal exige `contingency:approve` (a rotina usa contexto de sistema); fechar a competência exige `snapshot:close` e uma pessoa identificada. Com processos sem classificação oficial, o fechamento só acontece com justificativa (gravada e auditada). Competência fechada é imutável.
- **Relatórios jurídicos (PDF)**: consultar e baixar exigem `legal_report:read` e a visibilidade do relatório (`legalReportWhere` em `src/modules/legal-reports/access.ts`): processo visível (o escritório externo só vê os relatórios dos processos do seu escritório; ele não tem `report:read`, então relatórios gerenciais e Power BI continuam fechados), todo documento citado visível e todas as permissões de leitura do conteúdo que o relatório traz (`parameters.requiredPermissions`: análise preliminar exige `brief:read`, prazos `deadline:read`, valores `contingency:read`; um R1 gerado pelo sistema com a análise preliminar não aparece para a diretoria nem para a contabilidade). Textos livres do relatório passam pela omissão de CPF e CNPJ (`redactPersonalIds`) e trecho de documento com CPF ou CNPJ não é citado. Gerar e gerar nova versão exigem `report:generate` **e** o papel do tipo (`GENERATOR_ROLES` em `src/modules/legal-reports/approvers.ts`: R1 e R4, administrador, gestor jurídico e advogado; R2, administrador, gestor jurídico e contabilidade; R3, administrador e gestor jurídico). Diretoria, auditoria e analista não geram. Aprovar exige uma pessoa com o papel de aprovação do tipo; substituir uma versão **aprovada** exige quem poderia aprová-la (conferido de novo com a linha travada). O contexto de sistema pode gerar, mas nunca substitui versão aprovada. O banco recusa alterar relatório emitido e excluir relatórios, itens, fontes e cenários.
- **DataJud**: "Sincronizar agora" na ficha e a consulta avulsa (`/consulta-datajud`, que não grava nada) exigem `court_sync:run`, e a sincronização exige também ver o processo. "Sincronizar a carteira agora", parâmetros e saúde da coleta exigem `admin:organization`. As gravações automáticas usam o contexto de sistema da organização e são auditadas como "Sistema · DataJud".
- Alterar `legal_hold` de documento exige `document:delete`. Registros com retenção legal não podem ser excluídos.
- Só o criador, admin ou gestor exclui uma tarefa; só o autor exclui o próprio comentário.
- O próprio usuário não pode se desativar nem rebaixar o próprio perfil, e a organização precisa manter ao menos um admin ativo. Usuário de escritório externo exige escritório ativo da organização e não tem unidade.

### Visibilidade por linha (resumo de `access.ts`)

As regras 1 a 13 estão no cabeçalho de `src/server/auth/access.ts`.

| Perfil | Processos, ocorrências, contratos | Documentos | Tarefas e prazos | Análises de IA |
|---|---|---|---|---|
| **Admin, Gestor jurídico** | Todos da organização, inclusive confidenciais. | Todos, em qualquer nível. | Todos. | Todas, exceto perguntas privadas de outros usuários. |
| **Executivo, Contabilidade, Auditoria** (regra 4) | Todos os **não confidenciais** da organização (o que podem fazer depende das permissões). | Nível `internal` cujos vínculos eles veem; `restricted` só se forem responsáveis pelo registro vinculado. | Sem vínculo, ou com todos os vínculos visíveis. | Objeto visível **e** todas as fontes documentais visíveis; perguntas só as próprias. |
| **Advogado** | Não confidenciais da **sua unidade** ou sem unidade, mais aqueles em que é responsável ou criador. | `internal` e `confidential` com vínculos visíveis; `restricted` só se for responsável pelo registro vinculado. | Vinculados: herdam a visibilidade do registro. Sem vínculo: pela unidade. | Como o executivo. |
| **Analista** | Como o advogado. | `internal` com vínculos visíveis; `restricted` só se for responsável pelo registro vinculado. | Como o advogado. | Como o executivo. |
| **Escritório externo** (regra 10) | Processos do **seu escritório** (`legal_processes.law_firm_id`), **inclusive confidenciais** (o escritório patrocina o caso), mais aqueles em que é responsável ou criador. Ocorrências e contratos só quando responsável ou criador. Nunca por unidade. | `internal` e `confidential` **com pelo menos um vínculo**, todos visíveis; `restricted` dos processos do escritório ou em que é responsável. Documentos **sem vínculo** da organização nunca aparecem (só os que ele mesmo enviou). | Herdam a visibilidade do registro; sem vínculo, só os próprios. | Não vê (sem `analysis:read`). |

Regras da v2:

- **Regra 11, registros do processo**: instâncias, valorações, garantias, classificações de risco, acordos, audiências e entradas de processo herdam a visibilidade do processo (`processChildWhere`). Análises preliminares exigem, além disso, que **todos os documentos-fonte** sejam visíveis (como a regra 8 das análises de IA).
- **Regra 12, dados de saúde (PD-04)**: documentos da categoria `sensitive_health` (atestado, laudo, CAT) são sempre gravados como `restricted` (`effectiveConfidentiality`, no envio e na edição) e só aparecem para admin, gestor jurídico, quem enviou e o responsável por um registro vinculado (ou o escritório do processo vinculado). Os formulários avisam.
- **Regra 13, e-mails simulados**: admin e gestor veem todos; os demais veem as mensagens endereçadas a eles ou disparadas por eles, e as mensagens sobre um processo (e análise preliminar) que conseguem ver.
- Empresas, escritórios, regras de distribuição, lotes de importação e competências mensais são registros da organização, protegidos por permissão (`organization_id = ctx.organizationId`).
- **Listas de opções do escritório externo** (regra 10): os serviços já devolvem as listas restritas, então toda tela e formulário que as usa fica coberto. `listLawFirmOptions` devolve só o escritório do próprio usuário (lista vazia se ele não tiver escritório). `listUserOptions` e `listHearingUserOptions` devolvem só os usuários do mesmo escritório, o próprio usuário e os responsáveis pelos processos que ele vê (`userDirectoryWhere` em `access.ts`); a lista de audiências inclui também os responsáveis pelas audiências visíveis. `listWorkUserOptions` (responsáveis e executores de prazos e tarefas) segue a mesma regra. Os demais perfis continuam recebendo todos os usuários e escritórios ativos. Em `/processos`, esse perfil não vê os filtros "Unidade" e "Escritório externo" nem as listas da estrutura interna; uma unidade ou escritório que chegue pela URL (por exemplo, um link do painel) continua aplicado, mas aparece num aviso com o link para removê-lo, nunca escondido. O formulário do processo também não lista as unidades da organização para ele (só a unidade atual do processo).

Sempre valem:

- isolamento por organização em todas as condições;
- linhas com `deleted_at` são invisíveis;
- quem enviou o documento sempre o vê;
- o responsável ou criador de um registro, e o responsável, executor ou criador de tarefa ou prazo, sempre vê o próprio item.

Documentos vinculados a vários registros exigem que **todos** os vínculos sejam visíveis. Documentos sem nenhum vínculo seguem só o nível de confidencialidade para os perfis internos; o escritório externo só vê os que ele mesmo enviou. Comentários e alertas seguem a entidade referenciada (`entityReferenceWhere`, que na v2 também resolve audiência, acordo, valoração, garantia, análise preliminar e entrada). Perguntas e respostas à IA são privadas de quem perguntou.

**Alertas exigem também a permissão de leitura do módulo referenciado** (regra 9), porque o título e a mensagem descrevem o registro (ex.: título e data de um prazo, título de um contrato). O mapa fica em `ALERT_ENTITY_READ_PERMISSION` (`src/modules/alerts/service.ts`): processo, audiência e entrada exigem `process:read`; ocorrência, `occurrence:read`; contrato, `contract:read`; documento, `document:read`; tarefa, `task:read`; prazo, `deadline:read`; análise de IA, `analysis:read`; análise preliminar, `brief:read`; valoração, garantia e acordo, `contingency:read`. Assim a contabilidade (sem leitura de contratos, ocorrências, tarefas, prazos e análises) e a diretoria (sem `brief:read`) não veem esses alertas. A central de alertas (lista, contagem por área e grupos), o sino do cabeçalho, o resumo diário e `resolveAlert` usam o mesmo filtro (`visibleAlertsWhere`, exportado para o painel reutilizar). Para o sino, que aparece em toda página, a condição é montada só para os tipos de entidade com alertas abertos na organização.

Detalhes que evitam vazamento por agregação ou derivação:

- o painel executivo, relatórios, painel de carga e alertas filtram cada indicador pelo escopo;
- **competência mensal fechada (política de totais)**: os totais da organização **incluindo processos sigilosos** (com o aviso "inclui N processo(s) sigiloso(s) não listado(s)") só aparecem para quem contabiliza a provisão, ou seja, perfis com `snapshot:close` (admin, gestor jurídico e contabilidade). Executivo e auditoria, mesmo com visão da organização inteira, recebem totais, classificações e variação calculados **só com os itens que conseguem ver**, com `hiddenCount` 0, igual ao escopo dos relatórios (`reportScope`, "Total da organização (exceto sigilosos)"). Vale para a tela, a lista de competências, o CSV e a **memória de cálculo** (XLSX e PDF). Na memória, os perfis com essa visão recebem também os **totais por empresa** com os sigilosos incluídos e só a nota "inclui N sigilosos": uma empresa cujo único processo é sigiloso mostra a provisão desse processo, sem o número dele. Esse detalhe é mais fino que o da página de provisão e dos relatórios (que somam por empresa só as linhas visíveis) e é uma decisão de política registrada;
- relatórios de competência fechada aplicam a visibilidade **atual** dos processos aos itens armazenados;
- a fila de conferência oculta o texto da página quando o usuário não pode ver o documento;
- trechos de fonte de prazos sugeridos só aparecem se a análise de origem (de IA ou preliminar) for visível;
- vínculos com registros invisíveis aparecem sem número ou título (busca global, documentos, e-mails);
- CPF/CNPJ é mascarado nas listas, na aba de partes e nas exportações;
- a contagem de "análises a revisar" do painel de carga aplica a visibilidade do processo, mas não a exigência de documentos-fonte visíveis (é só contagem, sem conteúdo).

### Entrada de processos registrada por analista (contexto delegado)

`intake:manage` é a permissão de **registrar a entrada de um processo** (`registerIncomingProcess` em `src/modules/intake/service.ts`). O analista tem `intake:manage`, mas não `process:write`. Para que ele consiga registrar a entrada, a função `processContext(ctx)` cria o processo e as duas partes iniciais (autor e réu) com o contexto `{ ...ctx, kind: "system" }` quando o usuário não tem `process:write`:

- **o que permite**: só essas três chamadas (`createProcess` e duas vezes `addParty`) dentro do registro da entrada; os documentos são enviados com o contexto original do analista (que tem `document:upload`), e a linha da entrada, o alerta, a auditoria `intake.create` e o job usam o contexto original;
- **o que mantém**: mesmo usuário (fica como criador do processo e ator da auditoria `legal_process.create`) e mesma organização; responsável, empresa e unidade informados são validados contra a organização (responsável precisa ser advogado, gestor ou escritório externo ativo; escritório externo só para quem tem `distribution:manage`, ver abaixo);
- **o que nunca faz**: o fluxo não define confidencialidade (o processo nasce não sigiloso), nem escritório externo, nem usa o contexto delegado para qualquer outra operação. Como criador, o analista passa a ver o processo pela regra 5 mesmo se ele for de outra unidade;
- **valor da causa**: o contexto delegado não oficializa valores. A regra é julgada pelo papel da pessoa (`canMakeClaimOfficial`), nunca pelo contexto de sistema: o valor informado pelo analista entra como valoração **proposta** na fila de conferência, e o cadastro fica sem valor da causa até alguém com `contingency:approve` aprovar;
- **por quê**: o fluxo de entrada (RF-05/RF-20) é operado pelo apoio jurídico, mas a edição livre de processos continua restrita a quem tem `process:write`. A alternativa (dar `process:write` ao analista) ampliaria o que ele pode alterar em toda a carteira visível.

Não reutilize esse padrão em outro módulo sem revisão de segurança.

### Responsável do processo e escritório externo (distribuição)

- `intake:manage` só define o **primeiro** responsável de um processo, e só advogado ou gestor interno (no registro da entrada ou em "Atribuir manualmente"). **Trocar** um responsável já definido e escolher um **escritório externo** exigem `distribution:manage`, conferido no serviço (`applyManualAssignment`, `assignIntakeManually`, `assignResponsible({ force })`, `registerIncomingProcess`), não só na tela. A tela da entrada esconde "Reatribuir" e os escritórios externos de quem não pode usá-los.
- O escritório do processo (`legal_processes.law_firm_id`, que dá acesso ao escritório inteiro pela regra 10) **acompanha o responsável externo**: um novo responsável de escritório (ou uma regra que fixa o escritório) vincula esse escritório; quando o processo pertencia ao escritório por causa do responsável anterior e o novo responsável é de fora dele, o escritório é desvinculado e **perde o acesso**. Um escritório vinculado ao processo independentemente do responsável (responsável interno) é mantido. A troca fica na auditoria `legal_process.assign` (campo `lawFirmId`).
- As atribuições travam a linha do processo (`FOR UPDATE`) antes de ler o responsável: duas atribuições simultâneas não se sobrepõem.

## Isolamento entre organizações

- `organizationId` vem **sempre** de `ctx` (sessão ou `systemContext` do worker), nunca de formulário, URL ou payload.
- Todo id estrangeiro recebido (responsável, unidade, empresa, escritório, processo, ocorrência, contrato, documento, análise de origem, análise preliminar, entrada, regra de distribuição) é verificado: pertence à organização e, para registros, é visível ao usuário. Usuários, unidades e escritórios precisam também estar ativos.
- Jobs carregam `organization_id` e rodam com `systemContext(orgId)`, que continua preso a uma única organização.
- Requisições da API de entrada usam a organização da chave; o usuário de leitura do Power BI só recebe linhas da organização registrada para ele em `bi_reader_roles`.
- As séries de índices (`index_series`, `index_series_values`) são dados públicos globais, sem `organization_id`; os rótulos do BI (`bi_labels`) também.
- Existe uma conta de outra organização no seed (`admin@outra.praetor.local`) para testes manuais de isolamento. Os testes automatizados de cada módulo cobrem o isolamento.
- "Processar fila agora" (admin) processa só os jobs pendentes da organização do administrador; os das demais ficam para o worker.
- A unicidade do número de processo por organização faz o `ConflictError` confirmar que um número existe, mesmo que o processo seja confidencial (a mensagem é genérica).

## Processos sigilosos: registro de acesso

- Ao abrir a ficha ou a edição de um processo confidencial, `recordConfidentialProcessView` grava `legal_process.view_confidential` na auditoria (perfil do usuário nos metadados), **no máximo uma vez por usuário, processo e hora**. A consulta do último registro usa tipo e id da entidade e, quando já há registro recente, termina sem abrir transação; só a gravação usa o bloqueio consultivo da transação (`pg_advisory_xact_lock`) para evitar duplicatas em acessos simultâneos.
- Na aba "Documentos e análises" do processo, a seção "Downloads de documentos sensíveis" lista quem baixou e quando os documentos sensíveis do processo (categoria atestado, laudo ou CAT, e documentos sigilosos ou restritos), lidos da auditoria `document.download`, só dos documentos que a pessoa consegue ver.
- A tela de auditoria tem o atalho "Acessos a processos sigilosos" (`acao=legal_process.view_confidential`).

## Proteção de documentos

- **Sem URL pública**: arquivos ficam em `STORAGE_DIR` (fora de `public/`) com chave opaca `<org>/<doc>/<versão>`. Nomes de arquivo nunca viram caminho, e há proteção contra path traversal. O arquivo original de cada importação de planilha também fica no storage (chave opaca) com seu SHA-256.
- **Download autenticado** (`GET /api/documents/[id]/versions/[versionId]/download`): exige sessão e `documentWhere`, responde 404 quando não visível e audita `document.download`. Cabeçalhos:
  - `Content-Disposition: attachment` (nome ASCII mais `filename*` RFC 5987);
  - `X-Content-Type-Options: nosniff`;
  - `Cache-Control: private, no-store`;
  - `Content-Security-Policy: default-src 'none'; sandbox`;
  - `Content-Type` com o MIME **detectado no upload**.
- **Uploads** (route handlers fora do proxy, para o corpo não ser bufferizado):
  - `POST /api/documents/upload` (documentos, inclusive os da entrada de processos) e `POST /api/imports/upload` (planilhas, `import:run`, até 15 MB, `.xlsx` validado pela assinatura ZIP; antes de descompactar, o diretório central do ZIP é lido e a planilha é recusada se o conteúdo descompactado declarado passar de 200 MB, se tiver mais de 10.000 entradas ou usar ZIP64 (proteção contra "zip bomb"); a análise também recusa mais de 50.000 linhas de dados);
  - exigem sessão (401);
  - **checagem CSRF de origem** nos dois: o cabeçalho `Origin` precisa existir e ser o host de `APP_URL` ou o da própria requisição, senão 403;
  - exigem `Content-Length`, verificado **antes** de ler o corpo (411/413), e corpo multipart (415).
- **Server actions**: o Next.js compara `Origin` com o host da requisição e rejeita origens diferentes. Atrás de proxy reverso, `Host`/`X-Forwarded-Host` precisam ser repassados corretamente. O corpo das ações é limitado a 2 MB, e arquivos passam pelos route handlers.
- **Validação do arquivo** (`src/modules/documents/validation.ts`):
  - tipo detectado por **assinatura (magic bytes)**: PDF, PNG, JPEG, DOCX (ZIP com `[Content_Types].xml` e `word/*`; `word/vbaProject.bin` é rejeitado) e texto (UTF-8 válido, sem bytes nulos; HTML, SVG e XML são rejeitados mesmo em `.txt`);
  - a extensão precisa corresponder ao tipo detectado;
  - tamanho máximo `MAX_UPLOAD_MB` e arquivo vazio rejeitado;
  - SHA-256 calculado, e versão idêntica à atual rejeitada;
  - nome sanitizado (sem caminho, controles ou bidi; até 180 caracteres).
- **Extração de texto** em job separado, com tempo limite de 60 s e texto limitado a 1.000.000 caracteres. O texto extraído é **dado não confiável**. PDFs guardam o número de páginas e o início de cada página; a leitura de uma página (`getDocumentVersionPageText`) exige `document:read` e `documentWhere`.
- Cabeçalhos globais (`next.config.ts`): `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` restritiva, `Cross-Origin-Opener-Policy: same-origin`. O header `X-Powered-By` é removido. Páginas têm `noindex` e `robots.txt` bloqueia indexação.

## Exportações e CSV

- Rotas de exportação exigem sessão e permissão e são auditadas **sem conteúdo** (só filtros, formato e contagem): carteira (`GET /api/processes/export`, `process:read`, `legal_process.export`, até 20.000 processos), relatórios (`GET /api/reports/<tipo>`, `report:read`, `report.export`), fechamento mensal (`GET /api/contingency/snapshots/[period]/csv`, `contingency:read`, `snapshot.export`), memória de cálculo da provisão (`GET /api/provision-memo/[period]?formato=xlsx|pdf`, `contingency:read`, `provision_memo.export`), PDF de relatório jurídico (`GET /api/legal-reports/[id]/pdf`, `legal_report:read` + visibilidade do relatório, hash conferido antes de entregar, `legal_report.download`), trilha de auditoria (`GET /admin/auditoria/exportar`, `audit:read`, `audit.export`, até 10.000 linhas), inconsistências e arquivo original da importação (`import:run`; `import_batch.export_issues` e `import_batch.download`).
- Downloads abertos por `next/link` (`ButtonLink`) levam `prefetch={false}` e o atributo `download`, para o navegador fazer uma única requisição (um `next/link` comum buscaria a rota duas vezes e registraria duas entradas): arquivo e inconsistências da importação e exportação da auditoria. Os demais são links `<a>` simples (o CSV do fechamento e a memória de cálculo também com `download`).
- Todas aplicam a visibilidade por linha de quem exporta; CPF/CNPJ saem mascarados.
- **Injeção de fórmula em planilhas**: células de texto que começam com `=`, `+`, `-`, `@`, tabulação ou CR recebem um apóstrofo na frente nos CSVs da carteira (`processes/export.ts`), dos relatórios (`reports/csv.ts`), da auditoria (`admin/audit-csv.ts`), das inconsistências da importação (`imports/csv.ts`) e do fechamento mensal (`contingency/csv.ts`, `csvText`; células de valor e percentual nunca recebem o apóstrofo, para valores negativos continuarem números). Nas exportações XLSX as células de texto são gravadas como texto.

## E-mails simulados

- Nenhuma mensagem sai da aplicação: o único provedor é o `SimulatedEmailProvider`, que não abre conexão de rede e recusa mensagens sem o prefixo "[Simulação]" no assunto. O endereço do remetente configurado precisa ser de domínio reservado (`.invalid`, `.test`, `example.com`…).
- Assunto, corpo (texto e HTML) e endereços **ficam gravados** em `email_messages` para a Central de e-mails, porque podem conter dados do processo. Eles **nunca são logados nem copiados para a auditoria**: a auditoria (`email.simulated_send`, `email.resend`) guarda só modelo, situação, modo e ids; erros do provedor são logados só com o nome do erro. A lista de chaves redigidas do logger não inclui campos de e-mail: a proteção é não passá-los ao logger.
- A visualização do HTML usa um iframe isolado (`sandbox`), sem execução de scripts nem navegação.
- Leitura e listagem seguem a regra 13; reenviar e gerar o resumo diário exigem `email:send`.
- O e-mail "Análise preliminar disponível" é gerado em contexto de sistema, mas o **resumo da análise** (síntese, pontos de atenção, possíveis prazos, contagens) só entra quando o **destinatário** pode abrir a análise (`brief:read` + `caseBriefWhere` montado com o perfil, unidade e escritório dele). Se algum documento-fonte estiver oculto para ele (por exemplo, também vinculado a uma ocorrência restrita), o e-mail leva só os dados do processo e o link, e a etapa da entrada registra o motivo.

## API de entrada (chaves de API)

- Rotas `/api/v1/*` ficam fora do proxy de sessão e não usam cookie: a autenticação é `Authorization: Bearer prt_…`. Chave ausente, malformada, desconhecida, revogada ou expirada recebe **401** sem dizer qual; chave sem o escopo, **403**.
- A chave (`prt_` + 32 bytes aleatórios em base64url) é mostrada **uma única vez** na criação. O banco guarda só o SHA-256 (`api_keys.key_hash`, único) e um prefixo para reconhecimento; a chave nunca é logada. Criar e revogar exigem `admin:organization` e são auditados (`api_key.create`, `api_key.revoke`, com prefixo e escopos). Validade opcional (data futura).
- Escopos: `intake:create` (`POST /api/v1/processos`) e `process:read` (`GET /api/v1/processos/{numero}`). A consulta só devolve processos **recebidos pela API** na mesma organização (os demais respondem 404), para a chave não servir de consulta à carteira.
- A organização vem **sempre** da chave; campos de organização no corpo são ignorados. A requisição roda com um contexto de sistema preso à organização da chave (nome "API: <nome da chave>" nas etapas da entrada), por isso o escopo é a única autorização: dê a cada sistema externo só os escopos de que ele precisa.
- O corpo da requisição **nunca** é guardado nem logado: `inbound_requests` registra só o resultado, os ids gerados, um código curto de erro e o SHA-256 do corpo (para recusar a mesma `Idempotency-Key` com outro conteúdo).
- Documentos em base64 passam pela mesma validação por assinatura dos uploads (só PDF, DOCX e TXT, extensão igual ao conteúdo), até 20 arquivos de até `MAX_UPLOAD_MB` cada. Limite de corpo, JSON obrigatório (415 caso contrário) e **60 requisições por minuto por chave**. Esse limite fica em memória, por instância do servidor.
- Detalhes do contrato em [API.md](API.md).

## Coleta no DataJud (CNJ)

- Só leitura na API pública do CNJ, com a chave **pública** publicada pelo próprio CNJ (`DATAJUD_API_KEY`). Sem a chave, nada é consultado.
- A rotina e os jobs usam o contexto de sistema da organização. Toda mudança automática fica na auditoria (`legal_process.court_sync`, ator "Sistema · DataJud", só campos e contagens). Mensagens de erro guardadas em `court_sync_states.last_error` e `court_sync_runs.error_message` são saneadas (nunca parâmetros de consulta nem conteúdo da resposta).
- Nada é encerrado ou apagado pelo DataJud: só campos vazios são preenchidos, divergências viram nota de conferência e encerramentos viram alerta.
- A consulta avulsa (`/consulta-datajud`) não grava nada e registra no log só o usuário e as contagens.

## Power BI

- O segredo do aplicativo (`POWERBI_CLIENT_SECRET`) e o token do Microsoft Entra ID ficam **só no servidor**; nunca vão para o banco, a tela ou os logs.
- `/paineis-bi` e `GET /api/bi/embed-token` exigem sessão e `report:read` (o escritório externo não tem). O navegador recebe só um token de incorporação do relatório escolhido, **somente leitura**, válido por 20 minutos e preso à identidade do usuário (`biUserKey`). Configuração, teste de conexão e atualização exigem `admin:organization`. Abertura de painel é auditada (`bi.embed_view`, no máximo uma vez por usuário e painel por hora), assim como mudanças de configuração, testes e pedidos de atualização.
- **Cada pessoa vê no painel o que vê no Praetor**: a tabela `bi_process_access` (visão `bi.acesso`) é recalculada pela rotina `bi_access_refresh` com `processWhere(ctx)` de cada usuário ativo, e o papel de segurança por linha do relatório filtra por ela. Uma mudança de acesso só chega ao Power BI na próxima atualização do conjunto de dados ([POWER_BI.md](POWER_BI.md#4-atualização-automática)).
- **Usuário de banco somente leitura** (`praetor_bi` ou `praetor_bi_<nome>`, criado por `scripts/bi-setup.ts`): lê só o schema `bi` (visões), não lê tabelas do sistema, não cria objetos; o bi-setup confere isso e desfaz tudo se algo falhar. Cada usuário de leitura serve a **uma** organização, registrada em `bi_reader_roles`; as visões filtram as linhas por essa organização dentro delas (quem lê as tabelas do sistema, como o próprio Praetor, vê tudo).
- **Barreira de segurança**: todas as visões do schema `bi` têm `security_barrier = true` (migração `0011`). Sem ela, uma função criada pelo usuário de leitura na própria sessão (o PostgreSQL dá `TEMPORARY` a todos por padrão) poderia receber linhas de outra organização antes do filtro da visão. O teste `tests/bi/data.test.ts` tenta exatamente isso e confere que toda visão do schema `bi` tem a opção. Como proteção adicional, o administrador do banco pode executar `REVOKE TEMPORARY ON DATABASE <banco> FROM PUBLIC`; o bi-setup avisa enquanto a permissão existir.
- Em banco compartilhado por várias organizações, o isolamento vale para as **linhas**; metadados gerais do PostgreSQL (nomes de tabelas, estatísticas aproximadas) continuam visíveis ao usuário de leitura. Para isolamento completo, um banco por organização.
- As visões não têm nomes de partes, CPF/CNPJ de pessoas nem texto de documentos.

## Segredos

- Segredos só em variáveis de ambiente (`.env` fora do git; `.env.example` sem valores). `ANTHROPIC_API_KEY`, `POWERBI_CLIENT_SECRET` e `BI_DB_PASSWORD` nunca vão para o banco, os logs ou o cliente. `getAiRuntimeInfo()`, `getCaseBriefRuntimeInfo()` e `getEmailRuntimeInfo()` expõem só modo, provedor e modelo.
- `DATAJUD_API_KEY` é a chave **pública** do CNJ (o CNJ pode trocá-la a qualquer momento); mesmo assim fica só no ambiente do servidor.
- Chaves da API de entrada ficam no banco só como hash SHA-256.
- Nesta versão não há credenciais de tribunais (MNI), certificados digitais nem credenciais de envio de e-mail.
- Sem segredo de assinatura de sessão: a sessão é um token opaco verificado no banco.

## Logs e redação

- Logger JSON (`src/server/lib/logger.ts`). As chaves `password`, `passwordHash`, `token`, `sessionToken`, `apiKey`, `authorization`, `cookie`, `extractedText`, `content`, `text`, `prompt`, `body`, `facts`, `question`, `answer` e `documentNumber` são substituídas por `[redacted]`. Strings são cortadas em 500 caracteres.
- Regra: logar apenas ids, códigos e contagens. **Nunca** conteúdo de documentos, texto extraído, prompts, perguntas ou respostas da IA, conteúdo de análises preliminares, assunto/corpo/endereço de e-mails ou valores de células de planilhas.
- Mensagens de erro do driver ou do Drizzle podem conter parâmetros de consulta. A fila (`safeErrorMessage`), os documentos e as importações (`errorSummary`) registram só nome e código do erro. O logger também descarta a mensagem de erros do banco (`DrizzleQueryError` ou erros do driver com SQLSTATE) e registra só nome e código; de outros erros guarda até 500 caracteres de `error.message`.
- As etapas registradas na entrada de processos e os erros de análises preliminares guardam só mensagens saneadas, nunca texto de documento.
- A tela de erro mostra só um código de referência, nunca mensagem ou stack.

## Trilha de auditoria

- `recordAudit` grava na mesma transação da mudança: criação, edição e exclusão de registros, partes, movimentações e obrigações; upload, nova versão, download e metadados de documentos; solicitação, conclusão, falha, revisão e aplicação de sugestões de IA; validação de prazos; mudanças administrativas; login e logout. Na v2 também: valores (proposta, oficialização, correção, rejeição, quitação), garantias, risco, acordos, fechamento e exportação de competências, audiências, instâncias, retirada e reativação da carteira, verificação, distribuição (`legal_process.assign`), entradas, análises preliminares, e-mails simulados, importações (análise, confirmação, desfazer, download), empresas, escritórios, parâmetros de contingência e e-mail, renovação e rescisão de contratos, acessos a processos sigilosos e todas as exportações.
- `diffChanges` registra só os campos alterados. `passwordHash`, `password`, `extractedText`, `documentNumber` e `counterpartyDocument` viram `[protegido]`, e textos longos viram "[texto longo alterado]". Títulos e trechos sugeridos pela IA, conteúdo de análises preliminares, observações e resultados de audiências e links de sala virtual não vão para a auditoria; importações registram só contagens.
- Consulta em **Administração, Auditoria** (`audit:read`: admin, gestor, auditoria), com exportação CSV, e na aba "Histórico" de cada registro (filtrada pela visibilidade do registro).
- **Sigilo na trilha completa**: quem tem `audit:read` mas não vê registros confidenciais (hoje, o perfil auditoria) recebe **todas** as entradas, para a trilha continuar completa (ação, usuário, data, IP e id do registro). Nas entradas sobre registros sigilosos, porém, o resumo é trocado por um texto neutro e os campos alterados não aparecem (`redacted`). Contam como sigilosos: processos, ocorrências e contratos confidenciais (inclusive excluídos, para cobrir a exclusão); registros do processo sigiloso (audiência, acordo, valoração, garantia, classificação de risco, análise preliminar, entrada, e-mail simulado; ações de filhos gravadas como `legal_process` já usam o id do processo); tarefas, prazos e documentos vinculados a eles; documentos que não são `internal` ou que são da categoria `sensitive_health` (regras 7 e 12); e análises de IA sobre qualquer um deles. Para quem não tem `snapshot:close`, contam também as entradas de **prévia e fechamento de competência** (`snapshot.generate`, `snapshot.close`) cuja competência inclui processo sigiloso (pelo item guardado ou porque o processo virou sigiloso depois), porque o resumo delas traz totais da organização com os valores sigilosos. A regra vale para a lista, o CSV e o resumo da administração (`listAuditLogs`, `exportAuditLogs`, `getAdminOverview`). Admin e gestor jurídico veem tudo.
- Ações novas desta rodada, todas sem conteúdo: coleta do DataJud (`legal_process.court_sync`, `organization.court_sync_request`), chaves e recebimentos da API (`api_key.*`, `inbound.receive`, `inbound.update_existing`), Power BI (`bi.*`, `organization.bi_settings_update`), pedidos (`claim.*`, `claim_assessment.create`, `risk_assessment.derive|override`), índices (`valuation.correction_index_set|replace`, `organization.correction_index_default_update`, `organization.index_series_refresh_request`), relatórios jurídicos (`legal_report.*`, `process_scenario.create`), memória de cálculo (`provision_memo.export`), distribuição após importação (`import_batch.distribute`) e a migração de fase e instância (`legal_process.phase_migration`). Descrições de pedidos nunca vão para a auditoria (podem vir de documentos).
- A auditoria é append-only na aplicação (não há função de edição). **Não há** proteção contra alteração direta no banco, e a retenção configurável (`auditLogRetentionDays`) é apenas informativa: nada é expurgado. O histórico de renovações e rescisões de contratos é lido da auditoria.

## Mitigações de prompt injection

Ver [docs/AI.md](AI.md). Em resumo:

- o texto de documentos e registros é tratado como dado não confiável;
- `neutralizeUntrustedText` remove caracteres invisíveis e de controle, normaliza sinais "<" parecidos e desarma tags delimitadoras (`<source>`, `</source>`, `<system>`…);
- as fontes vão só dentro de blocos `<source ref="Sn">`, e o system prompt fixo declara esse conteúdo como dado e manda ignorar instruções nele;
- a saída é estruturada e validada por zod, e citações a referências inexistentes são descartadas;
- o modelo sinaliza `promptInjectionSuspected`, e a interface mostra o aviso;
- só entram fontes **visíveis ao solicitante**;
- a IA **não tem ferramentas nem permissões de escrita**: sugestões só viram tarefas ou prazos por ação humana, e prazos ficam pendentes de validação;
- a análise preliminar simulada ignora e sinaliza linhas que parecem instruções a uma IA (mesma lista de frases do modo demonstrativo); o adaptador real (não ativado) segue as mesmas regras de blocos delimitados.

## Retenção e exclusão

- **Exclusão lógica** (`deleted_at`) em processos, ocorrências, contratos, documentos, tarefas, prazos, comentários, garantias, acordos e audiências (audiências não têm exclusão pela interface: são canceladas com motivo). Dados excluídos somem das telas mas continuam no banco. **Os arquivos de documentos excluídos continuam no disco.**
- Valorações, classificações de risco, avaliações de pedidos e seus vínculos com o risco, revisões de análises preliminares, itens de competências fechadas, ressalvas de fechamento, relatórios jurídicos emitidos (com itens, fontes e cenários) e os valores das séries de índices **não são excluídos nem alterados** pela aplicação; nos relatórios jurídicos o banco também recusa (ver [DATA_MODEL.md](DATA_MODEL.md#histórico-imutável-append-only)).
- **Retenção legal** (`legal_hold`) bloqueia a exclusão de processos, ocorrências, contratos e documentos.
- **Rotina `retention_review`**: conta registros elegíveis para revisão (encerrados, arquivados ou resolvidos há mais de `closedRecordRetentionDays`, e documentos com `retention_until` vencido), sempre respeitando `legal_hold`. **Não há expurgo automático** nem exclusão física nesta versão.

## O que ainda precisa ser avaliado antes de uso em produção

Esta lista **não é exaustiva**:

- **Teste de intrusão (pentest)** e revisão de segurança independente, incluindo os perfis novos (escritório externo, contabilidade, auditoria) e o contexto delegado da entrada de processos.
- **MFA e SSO** (SAML/OIDC); hoje só há e-mail e senha.
- **Limitação de tentativas distribuída** (Redis ou banco), por IP e por conta, com bloqueio progressivo; hoje é em memória por processo.
- **Criptografia em repouso** dos arquivos (disco/volume criptografado ou storage com SSE-KMS) e do banco; avaliar criptografia de campos sensíveis (CPF/CNPJ).
- **Backup e recuperação de desastres**: política, backup diário, testes de restauração periódicos, RPO/RTO, cópia fora do site (banco **e** `STORAGE_DIR` juntos). Hoje há só os scripts manuais de [OPERATIONS.md](OPERATIONS.md#backup-e-restauração).
- **Avaliação LGPD / RIPD (DPIA)**: bases legais, minimização, registro das operações de tratamento, papéis (controlador/operador), encarregado (DPO); controles dos dados sensíveis do caderno de requisitos (PD-03 e PD-05 não têm controle próprio, ver [RASTREABILIDADE.md](RASTREABILIDADE.md#dados-pessoais-pd)).
- **Direitos dos titulares**: acesso, correção, anonimização e eliminação. Não há fluxo para isso.
- **Expurgo e retenção efetivos**: exclusão física de registros e arquivos após revisão, expurgo da auditoria.
- **Varredura de malware** nos uploads (ex.: ClamAV ou serviço gerenciado) antes de disponibilizar o download; marca d'água no visualizador de peças (PD-07).
- **CSP endurecida** para as páginas (nonce/hash de scripts); hoje só a resposta de download tem CSP.
- **Rotação de segredos** (chave da API de IA, credenciais do banco) e uso de cofre de segredos, obrigatório antes de qualquer integração com tribunal (certificado digital) ou e-mail real.
- **Gestão de sessões pelo usuário** (listar e encerrar sessões ativas), expiração por inatividade e reautenticação para ações sensíveis.
- **Monitoramento e alertas** de segurança (falhas de login, acessos negados, downloads e exportações em massa, erros), retenção e centralização de logs.
- **Teste de carga** e limites de taxa nas rotas de upload, download, exportação e IA.
- **Contrato de tratamento de dados com o fornecedor de IA** (retenção, uso para treinamento, localização dos dados, subprocessadores) antes de enviar documentos reais no modo real, inclusive para ativar a IA real da análise preliminar.
- Revisar o **registro de erros** para nunca incluir parâmetros de consulta (ver "Logs e redação").
- Proteção de integridade da trilha de auditoria (append-only no banco, exportação para armazenamento imutável).
- **API de entrada**: limite de requisições compartilhado entre instâncias (hoje em memória), rotação periódica das chaves, lista de IPs permitidos por chave e monitoramento de recusas (401, 403, 429).
- **Power BI**: rotação do segredo do aplicativo (as credenciais de teste usadas no desenvolvimento devem ser trocadas), `REVOKE TEMPORARY ON DATABASE` para os usuários de leitura e, com dados de várias organizações, um banco por organização.
- **DataJud**: termo de uso da API pública do CNJ e acompanhamento das mudanças da chave pública.
- Política de senhas mais forte (lista de senhas vazadas, expiração), recuperação de senha por e-mail (não existe) e convite de usuários.
