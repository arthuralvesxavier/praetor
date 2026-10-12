# Como adicionar um módulo

Checklist para um novo domínio, por exemplo `pareceres` (identificador em inglês: `opinions`). Siga a ordem e use um módulo existente como referência: `contracts` é pequeno e completo.

Leia antes: [MODULE_CONTRACTS.md](MODULE_CONTRACTS.md), [NEXTJS_16_NOTES.md](NEXTJS_16_NOTES.md) e [../SECURITY.md](../SECURITY.md).

## 1. Domínio e schema

- [ ] Enums novos em `src/domain/enums.ts`: array `as const`, tipo e `*_LABELS` em pt-BR ([ADR-0003](../adr/0003-enums-as-text.md)). Se o registro puder receber comentários, alertas ou auditoria, avalie incluir o tipo em `ENTITY_TYPES` e o link em `entityHref` (`src/domain/entities.ts`).
- [ ] Tabela em `src/server/db/schema/<arquivo>.ts`, exportada em `index.ts`. Inclua:
  - `id()`, `organizationId` (FK `organizations`) e `createdAt()`/`updatedAt()`;
  - `deletedAt()` se houver exclusão;
  - para seguir a visibilidade padrão: `unitId`, `responsibleId`, `createdById`, `isConfidential` e `legalHold` se aplicável;
  - `dataOrigin` se o dado puder vir de importação;
  - dinheiro em centavos (`bigint`); datas de calendário como `date` em modo string;
  - índices pelos filtros de lista (`organization_id` + status etc.).

## 2. Migração

- [ ] `npm run db:generate -- --name add_opinions`, revisar o SQL em `drizzle/` e `npm run db:migrate`.
- [ ] Nunca editar migrações já aplicadas.

## 3. Visibilidade (`src/server/auth/access.ts` — foundation)

- [ ] Se a tabela tiver as colunas de `ScopedTable`, use `scopedRecordWhere(ctx, table)`. Senão, escreva um builder novo com isolamento por organização, `deleted_at` e regras por perfil. Documente a regra no cabeçalho do arquivo e em `docs/SECURITY.md`.
- [ ] Se itens filhos (documentos, tarefas, prazos) puderem se vincular ao novo registro, atualize `parentsVisible`/`documentWhere`/`entityReferenceWhere`. Isso exige mudança de schema nas tabelas filhas.

## 4. `schemas.ts` (client-safe)

- [ ] Schemas zod de entrada (criar, atualizar parcial **sem defaults** e filtros de lista) com mensagens pt-BR.
- [ ] Ids com `z.guid()` (aceita qualquer UUID no formato 8-4-4-4-12). Datas `YYYY-MM-DD` validadas como datas reais. Dinheiro em inteiro (centavos).
- [ ] Sem imports de `@/server/*`.

## 5. `service.ts` (servidor; sem `next/*` e sem `@/server/auth/session`)

- [ ] Toda função recebe `ctx: AuthContext` primeiro e chama `assertCan(ctx, "<perm>")`.
- [ ] Valida a entrada com zod e lança `ValidationError` com `z.flattenError(err).fieldErrors`.
- [ ] Aplica o `*Where(ctx)` em **toda** consulta: lista, contagem, leitura unitária (`and(eq(t.id, id), scope)` com `NotFoundError`) e carga antes de escrever.
- [ ] Verifica cada id estrangeiro recebido:
  - usuário e unidade da organização, e ativos;
  - registros vinculados visíveis (`processWhere` etc.).
- [ ] Mutações em `getDb().transaction(async (tx) => …)` com `recordAudit(ctx, { action: "opinion.create", entityType, entityId, summary, changes: diffChanges(before, after) }, tx)`. Sem conteúdo sensível na auditoria.
- [ ] Se o registro for fonte de análise de IA, chame `markAnalysesStaleForEntity({ organizationId, entityId, reason }, tx)` quando campos relevantes mudarem. Para o registro ser analisável, também é preciso estender `src/modules/analyses/sources.ts` e `ANALYSIS_SUBJECT_TYPES`.
- [ ] Listas retornam `Paginated<T>` com `normalizePage(page)`.
- [ ] Exclusão lógica (`deletedAt`), respeitando `legalHold`.
- [ ] Nunca logar conteúdo; logar só ids e códigos.

## 6. `actions.ts`

- [ ] `"use server"`; cada ação chama `requireActionContext("<perm>")`, chama o serviço e `revalidatePath(...)`, e retorna `ActionResult`.
- [ ] `try/catch` com `logger.error("action_failed", { action, error })` só para erros inesperados (não `AppError`), mais `toActionError(err)`.
- [ ] `redirect()` **fora** do `try`.

## 7. Componentes (`src/modules/opinions/components/`)

- [ ] Server components por padrão. `"use client"` só para formulários (`useActionState`), diálogos e abas interativas, e sem importar `@/server/*` ou `service.ts`: passe dados por props.
- [ ] Use `src/components/ui` (ver `src/components/ui/README.md`): `FormField`, `SubmitButton`, `FilterBar`, `Pagination`, `TableEmpty`, `OriginBadge`, `RiskBadge`, `ConfirmDialog`…
- [ ] Formulários acessíveis: rótulos, erro por campo (`fieldError(state, "campo")`), valores preservados após erro de validação (React 19 reseta o formulário; ver `usePreservingSubmit` em contracts ou `useFormAction` em work).

## 8. Páginas (`src/app/(app)/<rota-pt-br>/`)

- [ ] Toda página chama `requirePageContext("<perm>")` (o layout não autoriza).
- [ ] Lista: filtros GET por parâmetros de URL (documente em `MODULE_CONTRACTS.md`), paginação (`pagina`), estado vazio e `loading.tsx`. Erros são tratados por `(app)/error.tsx`.
- [ ] Detalhe: `notFound()` para `NotFoundError`. Abas por `?aba=`, escondidas sem permissão. Inclua conforme o caso `EntityDocuments`, `EntityWorkItems`, `AnalysisPanel`, `CommentThread` e `EntityHistory`.
- [ ] `params`/`searchParams` são Promises; use `PageProps<"/rota/[id]">`.
- [ ] Textos em pt-BR com acentuação correta; tabelas em `overflow-x-auto`; uma coluna no celular.

## 9. Navegação e permissões

- [ ] Item no grupo certo de `NAV_GROUPS` em `src/lib/nav.ts`, com `permissions` (aparece com qualquer uma delas) e ícone `lucide-react`.
- [ ] Permissões novas em `src/server/auth/permissions.ts` (`PERMISSIONS`, `ROLE_PERMISSIONS`, `PERMISSION_LABELS`; foundation). Atualize a matriz em `docs/SECURITY.md`. A tela `/admin/permissoes` é gerada do código.
- [ ] Rótulos de auditoria das novas ações em `src/modules/admin/history-format.ts` (senão o histórico mostra o id cru).

## 10. Testes (`tests/opinions/`)

- [ ] `createTestDatabase()` em `beforeAll` (PGlite com migrações). Crie fixtures de duas organizações, unidades e usuários de cada perfil (veja `tests/access.smoke.test.ts`).
- [ ] Cubra:
  - isolamento entre organizações (inclusive ids estrangeiros de outra organização);
  - escopo por unidade e confidencialidade;
  - permissões por perfil (executivo só leitura);
  - validação;
  - auditoria gravada;
  - exclusão lógica e retenção legal.
- [ ] Mocke serviços de outros módulos com `vi.mock` quando necessário (ex.: `@/modules/analyses/service`).
- [ ] No Windows, rode o Vitest pelo PowerShell (ver "Armadilhas" no `AGENTS.md`).

## 11. Documentação

- [ ] `docs/STATUS.md` (implementado / simulado / pendente) e, se o módulo atende requisitos do cliente, `docs/RASTREABILIDADE.md`.
- [ ] Se o módulo depende de serviço externo ainda não contratado, coloque-o atrás de uma interface de provedor com implementação simulada e rotulada ([ADR-0010](../adr/0010-simulated-integrations-behind-interfaces.md)).
- [ ] `docs/dev/MODULE_CONTRACTS.md` se o módulo expõe APIs ou parâmetros de URL para outros módulos.
- [ ] `docs/DATA_MODEL.md` (tabela nova) e `docs/SECURITY.md` (regras de acesso).
- [ ] `npm run validate` antes de entregar.
