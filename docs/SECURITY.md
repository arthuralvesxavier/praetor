# Segurança

Este documento descreve os controles **implementados** nesta versão e os que ainda faltam.

> **Aviso importante.** O Praetor **não declara conformidade legal** (LGPD, sigilo profissional, normas setoriais ou outras) **nem segurança completa**. Os controles abaixo são uma base técnica. Antes de qualquer uso com dados reais é preciso fazer as avaliações listadas em [O que ainda precisa ser avaliado antes de uso em produção](#o-que-ainda-precisa-ser-avaliado-antes-de-uso-em-produção).

## Autenticação

- **Senhas**: argon2id (`@node-rs/argon2`, parâmetros padrão da biblioteca). A política mínima (`passwordPolicyError`) exige 10 caracteres, com letras e números. Senhas nunca são logadas nem auditadas.
- **Sessões opacas no banco** ([ADR-0005](adr/0005-db-sessions.md)):
  - o token tem 32 bytes aleatórios (base64url) e fica só no cookie; o banco guarda apenas o SHA-256 dele (`sessions.id`);
  - cookie `praetor_session` com `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` quando `APP_URL` começa com `https://`, e expiração de `SESSION_TTL_HOURS` (12 h por padrão);
  - a cada requisição a sessão é resolvida junto com o usuário: usuário inativo, sessão expirada ou organização divergente invalidam o acesso. Perfil e unidade são relidos, então mudanças valem na próxima requisição;
  - "Sair" apaga a sessão no banco e o cookie (o cookie é removido mesmo se a revogação falhar). Desativação, troca de perfil ou unidade e redefinição de senha revogam todas as sessões do usuário;
  - sessões expiradas são limpas de forma oportunista a cada login.
- **Login**: mensagem genérica ("E-mail ou senha inválidos.") e verificação de hash simulada para e-mails desconhecidos (tempo de resposta parecido). O redirecionamento `?next=` passa por `safeNextPath`, que bloqueia open redirect.
- **Limitação de tentativas**: 5 falhas por e-mail + IP em 15 minutos. **É em memória, por processo**: com várias instâncias, ou após um reinício, o contador não é compartilhado (pendente: armazenamento compartilhado).
- Logins, falhas de login (de e-mails existentes) e saídas são auditados (`auth.login`, `auth.login_failed`, `auth.logout`).
- `src/proxy.ts` só redireciona quem não tem cookie. **Não é autorização.**

## Autorização

Duas verificações independentes, ambas obrigatórias em todo serviço:

1. **Permissão de ação**: `assertCan(ctx, perm)` (`src/server/auth/permissions.ts`).
2. **Visibilidade por linha**: o builder `*Where(ctx)` de `src/server/auth/access.ts` em **toda** consulta (listas, contagens, leituras unitárias, escritas). Leituras unitárias usam `id AND escopo` e devolvem `NotFoundError` sem revelar se o registro existe. Ver [ADR-0009](adr/0009-row-visibility-in-services.md).

Páginas chamam `requirePageContext(perm)`, ações `requireActionContext(perm)` e route handlers `getCurrentUser()`. Esconder botões e itens de menu é só conveniência.

### Matriz de permissões

| Permissão | Admin | Gestor jurídico | Advogado | Analista | Executivo |
|---|:-:|:-:|:-:|:-:|:-:|
| `dashboard:read`, `*:read` (processos, ocorrências, contratos, documentos, tarefas, prazos, análises) | ✔ | ✔ | ✔ | ✔ | ✔ |
| `process:write` | ✔ | ✔ | ✔ | — | — |
| `occurrence:write`, `contract:write` | ✔ | ✔ | ✔ | ✔ | — |
| `process:delete`, `occurrence:delete`, `contract:delete`, `document:delete` | ✔ | ✔ | — | — | — |
| `document:upload`, `task:write`, `deadline:write`, `comment:write` | ✔ | ✔ | ✔ | ✔ | — |
| `deadline:validate` (validar prazos sugeridos pela IA) | ✔ | ✔ | ✔ | — | — |
| `alert:resolve` | ✔ | ✔ | ✔ | — | — |
| `analysis:request` | ✔ | ✔ | ✔ | ✔ | — |
| `analysis:review` | ✔ | ✔ | ✔ | — | — |
| `audit:read` | ✔ | ✔ | — | — | — |
| `admin:users` (usuários, equipes, unidades) | ✔ | — | — | — | — |
| `admin:organization` (configurações, IA, rotinas) | ✔ | — | — | — | — |

A matriz também aparece em **Administração → Permissões** (gerada do código).

Regras adicionais aplicadas nos serviços:

- Só admin e gestor jurídico marcam ou desmarcam `is_confidential` em processos, ocorrências e contratos. Um processo criado a partir de ocorrência confidencial herda a confidencialidade.
- Alterar `legal_hold` de documento exige `document:delete`. Registros com retenção legal não podem ser excluídos.
- Só o criador, admin ou gestor exclui uma tarefa; só o autor exclui o próprio comentário.
- O próprio usuário não pode se desativar nem rebaixar o próprio perfil, e a organização precisa manter ao menos um admin ativo.

### Visibilidade por linha (resumo de `access.ts`)

| Perfil | Processos, ocorrências, contratos | Documentos | Tarefas e prazos | Análises de IA |
|---|---|---|---|---|
| **Admin, Gestor jurídico** | Todos da organização, inclusive confidenciais. | Todos, em qualquer nível. | Todos. | Todas, exceto perguntas privadas de outros usuários. |
| **Executivo** | Todos os **não confidenciais** da organização. | Nível `internal` cujos vínculos ele vê; `restricted` só se for responsável pelo registro vinculado. | Sem vínculo, ou com todos os vínculos visíveis. | Objeto visível **e** todas as fontes documentais visíveis; perguntas só as próprias. |
| **Advogado** | Não confidenciais da **sua unidade** ou sem unidade, mais aqueles em que é responsável ou criador. | `internal` e `confidential` com vínculos visíveis; `restricted` só se for responsável pelo registro vinculado. | Vinculados: herdam a visibilidade do registro. Sem vínculo: pela unidade. | Como o executivo. |
| **Analista** | Como o advogado. | `internal` com vínculos visíveis; `restricted` só se for responsável pelo registro vinculado. | Como o advogado. | Como o executivo. |

Sempre valem:

- isolamento por organização em todas as condições;
- linhas com `deleted_at` são invisíveis;
- quem enviou o documento sempre o vê;
- o responsável ou criador de um registro, e o responsável, executor ou criador de tarefa ou prazo, sempre vê o próprio item.

Documentos vinculados a vários registros exigem que **todos** os vínculos sejam visíveis. Comentários e alertas seguem a entidade referenciada (`entityReferenceWhere`). Perguntas e respostas à IA são privadas de quem perguntou.

Detalhes que evitam vazamento por agregação ou derivação:

- o dashboard filtra cada indicador pelo escopo;
- trechos de fonte de prazos sugeridos só aparecem se a análise de origem for visível;
- vínculos com registros invisíveis aparecem sem número ou título;
- CPF/CNPJ é mascarado nas listas.

## Isolamento entre organizações

- `organizationId` vem **sempre** de `ctx` (sessão ou `systemContext` do worker), nunca de formulário, URL ou payload.
- Todo id estrangeiro recebido (responsável, unidade, processo, ocorrência, contrato, documento, análise de origem) é verificado: pertence à organização e, para registros, é visível ao usuário. Usuários e unidades precisam também estar ativos.
- Jobs carregam `organization_id` e rodam com `systemContext(orgId)`, que continua preso a uma única organização.
- Existe uma conta de outra organização no seed (`admin@outra.praetor.local`) para testes manuais de isolamento. Os testes automatizados de cada módulo cobrem o isolamento.
- "Processar fila agora" (admin) processa só os jobs pendentes da organização do administrador; os das demais ficam para o worker.
- A unicidade do número de processo por organização faz o `ConflictError` confirmar que um número existe, mesmo que o processo seja confidencial (a mensagem é genérica).

## Proteção de documentos

- **Sem URL pública**: arquivos ficam em `STORAGE_DIR` (fora de `public/`) com chave opaca `<org>/<doc>/<versão>`. Nomes de arquivo nunca viram caminho, e há proteção contra path traversal.
- **Download autenticado** (`GET /api/documents/[id]/versions/[versionId]/download`): exige sessão e `documentWhere`, responde 404 quando não visível e audita `document.download`. Cabeçalhos:
  - `Content-Disposition: attachment` (nome ASCII mais `filename*` RFC 5987);
  - `X-Content-Type-Options: nosniff`;
  - `Cache-Control: private, no-store`;
  - `Content-Security-Policy: default-src 'none'; sandbox`;
  - `Content-Type` com o MIME **detectado no upload**.
- **Upload** (`POST /api/documents/upload`, route handler fora do proxy):
  - exige sessão (401);
  - **checagem CSRF de origem**: o cabeçalho `Origin` deve ser o host de `APP_URL` ou o da própria requisição, senão 403;
  - exige `Content-Length`, verificado **antes** de ler o corpo (411/413), e corpo multipart (415).
- **Server actions**: o Next.js compara `Origin` com o host da requisição e rejeita origens diferentes. Atrás de proxy reverso, `Host`/`X-Forwarded-Host` precisam ser repassados corretamente. O corpo das ações é limitado a 2 MB, e arquivos passam pelo route handler.
- **Validação do arquivo** (`src/modules/documents/validation.ts`):
  - tipo detectado por **assinatura (magic bytes)**: PDF, PNG, JPEG, DOCX (ZIP com `[Content_Types].xml` e `word/*`; `word/vbaProject.bin` é rejeitado) e texto (UTF-8 válido, sem bytes nulos; HTML, SVG e XML são rejeitados mesmo em `.txt`);
  - a extensão precisa corresponder ao tipo detectado;
  - tamanho máximo `MAX_UPLOAD_MB` e arquivo vazio rejeitado;
  - SHA-256 calculado, e versão idêntica à atual rejeitada;
  - nome sanitizado (sem caminho, controles ou bidi; até 180 caracteres).
- **Extração de texto** em job separado, com tempo limite de 60 s e texto limitado a 1.000.000 caracteres. O texto extraído é **dado não confiável**.
- Cabeçalhos globais (`next.config.ts`): `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` restritiva, `Cross-Origin-Opener-Policy: same-origin`. O header `X-Powered-By` é removido. Páginas têm `noindex` e `robots.txt` bloqueia indexação.

## Segredos

- Segredos só em variáveis de ambiente (`.env` fora do git; `.env.example` sem valores). `ANTHROPIC_API_KEY` nunca vai para o banco, os logs ou o cliente. `getAiRuntimeInfo()` expõe só modo, provedor e modelo.
- Sem segredo de assinatura de sessão: a sessão é um token opaco verificado no banco.

## Logs e redação

- Logger JSON (`src/server/lib/logger.ts`). As chaves `password`, `passwordHash`, `token`, `sessionToken`, `apiKey`, `authorization`, `cookie`, `extractedText`, `content`, `text`, `prompt`, `body`, `facts`, `question`, `answer` e `documentNumber` são substituídas por `[redacted]`. Strings são cortadas em 500 caracteres.
- Regra: logar apenas ids, códigos e contagens. **Nunca** conteúdo de documentos, texto extraído, prompts, perguntas ou respostas da IA.
- Mensagens de erro do driver ou do Drizzle podem conter parâmetros de consulta. A fila (`safeErrorMessage`) e o módulo de documentos (`errorSummary`) registram só nome e código do erro. O logger também descarta a mensagem de erros do banco (`DrizzleQueryError` ou erros do driver com SQLSTATE) e registra só nome e código; de outros erros guarda até 500 caracteres de `error.message`.
- A tela de erro mostra só um código de referência, nunca mensagem ou stack.

## Trilha de auditoria

- `recordAudit` grava na mesma transação da mudança: criação, edição e exclusão de registros, partes, movimentações e obrigações; upload, nova versão, download e metadados de documentos; solicitação, conclusão, falha, revisão e aplicação de sugestões de IA; validação de prazos; mudanças administrativas (usuários, equipes, unidades, configurações, rotinas); login e logout.
- `diffChanges` registra só os campos alterados. `passwordHash`, `password`, `extractedText`, `documentNumber` e `counterpartyDocument` viram `[protegido]`, e textos longos viram "[texto longo alterado]". Títulos e trechos sugeridos pela IA não vão para a auditoria.
- Consulta em **Administração → Auditoria** (`audit:read`) e na aba "Histórico" de cada registro (filtrada pela visibilidade do registro).
- A auditoria é append-only na aplicação (não há função de edição). **Não há** proteção contra alteração direta no banco, e a retenção configurável (`auditLogRetentionDays`) é apenas informativa: nada é expurgado.

## Mitigações de prompt injection

Ver [docs/AI.md](AI.md). Em resumo:

- o texto de documentos e registros é tratado como dado não confiável;
- `neutralizeUntrustedText` remove caracteres invisíveis e de controle, normaliza sinais "<" parecidos e desarma tags delimitadoras (`<source>`, `</source>`, `<system>`…);
- as fontes vão só dentro de blocos `<source ref="Sn">`, e o system prompt fixo declara esse conteúdo como dado e manda ignorar instruções nele;
- a saída é estruturada e validada por zod, e citações a referências inexistentes são descartadas;
- o modelo sinaliza `promptInjectionSuspected`, e a interface mostra o aviso;
- só entram fontes **visíveis ao solicitante**;
- a IA **não tem ferramentas nem permissões de escrita**: sugestões só viram tarefas ou prazos por ação humana, e prazos ficam pendentes de validação.

## Retenção e exclusão

- **Exclusão lógica** (`deleted_at`) em processos, ocorrências, contratos, documentos, tarefas, prazos e comentários. Dados excluídos somem das telas mas continuam no banco. **Os arquivos de documentos excluídos continuam no disco.**
- **Retenção legal** (`legal_hold`) bloqueia a exclusão de processos, ocorrências, contratos e documentos.
- **Rotina `retention_review`**: conta registros elegíveis para revisão (encerrados, arquivados ou resolvidos há mais de `closedRecordRetentionDays`, e documentos com `retention_until` vencido), sempre respeitando `legal_hold`. **Não há expurgo automático** nem exclusão física nesta versão.

## O que ainda precisa ser avaliado antes de uso em produção

Esta lista **não é exaustiva**:

- **Teste de intrusão (pentest)** e revisão de segurança independente.
- **MFA e SSO** (SAML/OIDC); hoje só há e-mail e senha.
- **Limitação de tentativas distribuída** (Redis ou banco), por IP e por conta, com bloqueio progressivo; hoje é em memória por processo.
- **Criptografia em repouso** dos arquivos (disco/volume criptografado ou storage com SSE-KMS) e do banco; avaliar criptografia de campos sensíveis (CPF/CNPJ).
- **Backup e recuperação de desastres**: política, testes de restauração, RPO/RTO, cópia fora do site (banco **e** `STORAGE_DIR` juntos).
- **Avaliação LGPD / RIPD (DPIA)**: bases legais, minimização, registro das operações de tratamento, papéis (controlador/operador), encarregado (DPO).
- **Direitos dos titulares**: acesso, correção, anonimização e eliminação. Não há fluxo para isso.
- **Expurgo e retenção efetivos**: exclusão física de registros e arquivos após revisão, expurgo da auditoria.
- **Varredura de malware** nos uploads (ex.: ClamAV ou serviço gerenciado) antes de disponibilizar o download.
- **CSP endurecida** para as páginas (nonce/hash de scripts); hoje só a resposta de download tem CSP.
- **Rotação de segredos** (chave da API de IA, credenciais do banco) e uso de cofre de segredos.
- **Gestão de sessões pelo usuário** (listar e encerrar sessões ativas), expiração por inatividade e reautenticação para ações sensíveis.
- **Monitoramento e alertas** de segurança (falhas de login, acessos negados, downloads em massa, erros), retenção e centralização de logs.
- **Teste de carga** e limites de taxa nas rotas de upload, download e IA.
- **Contrato de tratamento de dados com o fornecedor de IA** (retenção, uso para treinamento, localização dos dados, subprocessadores) antes de enviar documentos reais no modo real.
- Revisar o **registro de erros** para nunca incluir parâmetros de consulta (ver "Logs e redação").
- Proteção de integridade da trilha de auditoria (append-only no banco, exportação para armazenamento imutável).
- Política de senhas mais forte (lista de senhas vazadas, expiração), recuperação de senha por e-mail (não existe) e convite de usuários.
