# Status do projeto

Primeira versão funcional (outubro de 2026). Esta página separa o que **funciona de verdade**, o que é **simulado ou demonstrativo** e o que está **pendente**. Atualize-a junto com cada funcionalidade (regra 9 do [AGENTS.md](../AGENTS.md)).

**Estado da verificação**:

- `npm run validate` passa por completo: `next typegen` + `tsc` sem erros, ESLint sem avisos, 267 testes Vitest em 28 arquivos (PGlite: serviços, permissões, isolamento entre organizações, visibilidade, injeção de prompt, uploads, fila, IA demonstrativa, fluxo integrado) e `next build` de produção;
- migrações e `seed --reset` aplicados no PostgreSQL de desenvolvimento;
- **teste de fumaça no servidor de produção** (`next start` + worker), com os 7 perfis demo: cerca de 55 telas e abas por perfil (dashboard, listas, detalhes com todas as abas, formulários, `/prazos`, `/ia`, `/admin/*`), filtros e URLs malformadas, sem erro de renderização. Permissões negadas levam a `/sem-permissao`; registros de outra organização, confidenciais ou de outra unidade mostram "não encontrado" sem vazar dados. Também verificados: login pelo formulário real, server actions (criar ocorrência, processo, contrato, prazo, tarefa, comentário; solicitar análise e pergunta; aplicar sugestão; validar prazo; revisão), negativas por perfil e por organização, download (anexo, `nosniff`, 404 para outra organização, 401 sem sessão), upload (201; 403 com origem estranha; 400 para HTML renomeado como PDF) e o worker processando extração e análises;
- **as telas ainda não foram inspecionadas visualmente em um navegador** (layout, celular, interações só no cliente).

## Implementado (funcional)

**Base**

- Página de apresentação pública em `/` (`src/app/page.tsx`): frentes preventiva e contenciosa, módulos, princípios de IA, governança e origem do nome. Não lê dados de organizações; com sessão ativa, o botão leva ao painel.
- Login com e-mail e senha (argon2id), sessões opacas no banco, logout, limite de tentativas (em memória), redirecionamento seguro `?next=`.
- Permissões por perfil (admin, gestor jurídico, advogado, analista, executivo) e visibilidade por linha (unidade, confidencialidade, responsável) em todas as consultas. Isolamento entre organizações.
- Auditoria das mudanças relevantes, com diff por campo e campos sensíveis protegidos. Histórico por registro e tela de auditoria.
- Shell responsivo (menu lateral e gaveta no celular), faixa de ambiente demonstrativo, selo do modo da IA, páginas de erro, 404, sem permissão e carregamento. `/api/health`.
- Design system (`src/components/ui`): badges de status, risco, prioridade e origem, filtros por URL, paginação, tabelas, diálogos e formulários acessíveis.

**Contencioso (`/processos`)**

- CRUD com exclusão lógica (bloqueada por retenção legal), unicidade do número por organização e checagem do **formato** CNJ.
- Partes (CPF/CNPJ só com dígitos e mascarado) e movimentações manuais. Movimentações importadas não podem ser removidas.
- Filtros, busca e indicadores. Abas de visão geral, partes, movimentações, documentos, prazos, IA, comentários e histórico.
- Criação a partir de uma ocorrência (pré-preenchimento e vínculo; herda a confidencialidade).

**Jurídico preventivo (`/preventivo`)**

- CRUD de ocorrências (fatos, áreas, informações faltantes, risco, exposição estimada), regras de datas e status.
- Vincular e desvincular processo ("Convertida em processo" só via vínculo).
- Plano de ação (tarefas `action_plan`) com progresso, card de sinais da IA e indicadores com links para os filtros.

**Contratos (`/contratos`)**

- CRUD e obrigações (incluir, editar, marcar cumprida, remover).
- Vigência e prazo de aviso **calculados a partir das datas informadas**.
- Filtros "vencendo" (configuração da organização) e "vencidos", e indicadores.

**Documentos (`/documentos`)**

- Upload com validação por assinatura do arquivo (PDF, DOCX, PNG, JPG, TXT, MD, CSV), limite de tamanho e checagem de origem (CSRF).
- Versões (versão idêntica rejeitada), extração de texto de PDF, DOCX e texto em segundo plano.
- Download autenticado em streaming, edição de metadados, exclusão lógica, retenção legal.
- Documentos dentro dos registros (`EntityDocuments`).

**Prazos e tarefas (`/prazos`)**

- Prazos manuais, tarefas, calendário mensal (agenda no celular) e filtros por situação, responsável e origem.
- Fila de **validação humana** de prazos sugeridos pela IA (validar, com ajuste opcional de data, ou rejeitar com justificativa).
- Prazos pendentes de validação não contam como reais.

**Comentários e alertas**

- Comentários em processos, ocorrências, contratos, documentos, tarefas, prazos e análises. Visibilidade segue a entidade; o autor exclui os próprios.
- Alertas de prazos, contratos, obrigações, sinais de risco, análises desatualizadas e falhas, com deduplicação e encerramento automático quando deixam de valer.

**Central de IA (`/ia`) e análises**

- Seis tipos de análise sobre processo, ocorrência, contrato ou documento, e perguntas à base da organização (busca textual em português filtrada pelo acesso do usuário).
- Fontes citadas e validadas, limitações, pontos de validação, aviso obrigatório e detecção de prompt injection.
- Deduplicação por hash de entrada, desatualização ao mudar fontes, revisão humana ("Revisada" ou "Descartada").
- Aplicação explícita de sugestões como tarefa ou como prazo pendente de validação.
- Orçamento mensal de tokens, limite de tamanho de entrada e painel de uso e custos.

**Segundo plano**

- Fila em PostgreSQL (`SKIP LOCKED`, deduplicação, backoff exponencial, recuperação de jobs presos) e worker.
- Rotinas configuráveis:
  - alertas de prazos;
  - alertas de vigência e obrigações;
  - reanálise de desatualizadas (desligada por padrão);
  - revisão de retenção (**só conta**).

**Painel de BI (`/dashboard`)**

- Filtros numa linha (parâmetros de URL `periodo`, `unidade`, `area`, `responsavel`): período (30 e 90 dias com granularidade semanal; 6 e 12 meses, ano atual e todo o período, este limitado a 36 meses, com granularidade mensal), unidade, área jurídica e responsável. A área filtra processos e os prazos/tarefas vinculados a eles; ocorrências e contratos não têm área.
- Indicadores (processos ativos com entradas no período e no período anterior, exposição e provisão informadas, prazos vencidos e próximos, ocorrências abertas, encerramentos, tarefas em atraso, contratos vencendo), cada um com link para a lista filtrada.
- Gráficos em HTML/CSS renderizados no servidor (`src/modules/dashboard/components/charts/`): entradas × encerramentos de processos, ocorrências registradas × resolvidas, risco atual (barras 100%), ocorrências por categoria, exposição por área e por probabilidade de perda, carga de prazos por semana, pendências por responsável e processos por fase, além da tabela de maiores exposições. Cada marca tem tooltip (hover e teclado), cada gráfico tem "Ver dados em tabela", e barras e trechos levam aos registros. Cores validadas com o validador de paleta (cores de status para risco, sempre com rótulo).
- Seção "Acompanhamento", sem filtros: próximos prazos, alertas, contratos, IA e atividade recente.
- Exposição financeira **informada nos cadastros** (não é estimativa da IA). Tudo calculado dentro do escopo de visibilidade do usuário (`src/modules/dashboard/bi-service.ts`), testado em `tests/dashboard/bi.test.ts`.
- Pendente: exportação (CSV/PDF), comparação entre períodos em gráfico, filtros salvos e modo escuro.

**Administração (`/admin`)**

- Usuários: criar, editar, ativar/desativar, redefinir senha; regras de último admin e de não se rebaixar; revogação de sessões.
- Equipes e unidades (unidade em uso é desativada em vez de excluída).
- Matriz de permissões e auditoria com filtros.
- Configurações da organização (IA, alertas, retenção), rotinas ("Executar agora", intervalo) e "Processar fila agora".

## Simulado / demonstrativo

- **Modo demonstrativo da IA** (`DemoProvider`): padrão sem `ANTHROPIC_API_KEY`. Regras de texto (datas, valores, palavras-chave), **sem inteligência artificial**. Todos os resultados, alertas e sugestões levam o rótulo "demonstrativo".
- **IA real (Anthropic)**: implementada com saída estruturada e fallback de recusa, mas **verificada só por tipos e por testes com provedor simulado**. Nenhuma chamada real foi feita.
- **Dados de demonstração** (`npm run db:seed`): organização fictícia "Grupo Aurora Exemplo S.A. (demonstração)" e "Outra Empresa Ltda. (teste de isolamento)". Os registros são criados pelos próprios serviços (mesmas regras da interface), com datas relativas ao dia da execução. Pessoas, empresas e números de processo são inventados; os números têm forma CNJ mas não correspondem a processos reais. O seed roda a IA em modo demonstrativo, a menos que `SEED_USE_LIVE_AI=true`.
- **Sem integração com tribunais**: não há consulta a PJe, e-SAJ, DataJud ou qualquer sistema. Movimentações são digitadas por pessoas ou marcadas como importadas com fonte informada, mas **não existe tela de importação**. O número CNJ é verificado só no formato, sem dígito verificador nem consulta.
- **Risco e probabilidade de perda** dos processos são campos humanos, não estimativas da IA.
- **Vigência e prazo de aviso** de contratos são cálculos simples de datas, não contagem de prazos legais. O sistema **não calcula prazos processuais**, por decisão de projeto.

## Pendente

**Verificação**

- Abrir todas as telas no navegador (desktop e celular) com cada perfil demo e conferir layout e interações do cliente (diálogos, abas, formulários).
- Status HTTP: com `loading.tsx`, "sem permissão" e "não encontrado" chegam como `200` com redirecionamento no cliente / `noindex` (comportamento do Next com streaming). Se for preciso `403`/`404` reais, fazer a checagem antes do streaming.
- Teste real com a API da Anthropic em ambiente controlado.

**Funcionalidades**

- OCR para imagens e PDFs digitalizados (hoje ficam como "Formato sem extração de texto").
- Edição de prazos e tarefas pela interface (hoje só a mudança de status; não há `updateDeadline`).
- Filtro por registro em `/prazos` (o link "Ver todos" dos registros abre a lista geral).
- Status "em atraso" automático de obrigações contratuais e motor de recorrência.
- Edição da retenção legal (`legal_hold`) de processos, ocorrências e contratos pela interface (hoje só documentos têm esse campo no formulário; nos demais, o valor só pode ser alterado direto no banco).
- Importação de processos e movimentações (arquivo) com rastreio de origem. Integração com tribunais só por fontes oficiais e após avaliação.
- Notificações por e-mail ou mensagem (alertas são apenas na aplicação).
- Busca semântica (embeddings) para perguntas à base; índice de texto completo materializado.
- Parâmetros de URL para links exatos do dashboard (ocorrências "em andamento", revisão pendente em `/ia`, probabilidade de perda em `/processos`).
- Seletores com busca para organizações grandes (os formulários listam até 300 registros por tipo).
- Tema escuro.

**Operação e segurança**

- Bootstrap de organização e primeiro administrador para produção (hoje só pelo seed de demonstração).
- Recuperação de senha, convite de usuários, MFA e SSO.
- Limitação de tentativas de login compartilhada entre instâncias.
- Expurgo efetivo após a revisão de retenção, remoção física dos arquivos de documentos excluídos e expurgo da auditoria (a configuração de retenção da auditoria é informativa).
- Limpeza de jobs concluídos.
- Redirecionar para `/login?next=…` quando o cookie existe mas a sessão expirou (sem cookie, o proxy já preserva o caminho em `?next=`).
- Revogação de sessões dentro da mesma transação da mudança de usuário.
- Itens de [SECURITY.md → O que ainda precisa ser avaliado antes de uso em produção](SECURITY.md#o-que-ainda-precisa-ser-avaliado-antes-de-uso-em-produção).

## Próximas etapas (por prioridade)

1. **Verificação visual e de ponta a ponta**:
   - percorrer cada tela no navegador com os seis perfis demo: criar processo a partir de ocorrência, enviar documento, solicitar análise, aplicar sugestão, validar prazo, conferir isolamento com `admin@outra.praetor.local`;
   - corrigir problemas de layout.
2. **Base para produção**: bootstrap de organização e admin, convite e recuperação de senha, limitação de tentativas distribuída, CSP nas páginas.
3. **Validação da IA real**: rodar com chave em ambiente controlado e dados fictícios; medir custo e qualidade; firmar contrato de tratamento de dados com o fornecedor antes de usar documentos reais.
4. **Avaliações de segurança e privacidade**: pentest, RIPD/LGPD, backup e restauração testados, varredura de malware nos uploads, criptografia em repouso.
5. **Produtividade do dia a dia**: edição de prazos e tarefas, filtros por registro em `/prazos`, notificações por e-mail, seletores com busca.
6. **Documentos**: OCR; expurgo controlado (com aprovação) após a revisão de retenção.
7. **Dados de entrada**: importação de processos e movimentações com origem rastreável; avaliar integrações oficiais com tribunais.
