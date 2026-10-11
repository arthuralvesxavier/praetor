# ADR-0005 — Sessões opacas no banco em vez de JWT ou biblioteca de autenticação

- **Status**: aceita
- **Data**: 2026-10

## Contexto

Usuários corporativos com perfis e unidades que mudam e podem ser desativados a qualquer momento. Requisitos: revogação imediata (desativação, troca de perfil, redefinição de senha), sem segredos de assinatura para gerenciar, e autorização baseada no estado atual do usuário.

## Decisão

- Login por e-mail e senha (argon2id) em `src/server/services/auth.ts`.
- O token de sessão tem 32 bytes aleatórios e vai em cookie `HttpOnly`, `SameSite=Lax`, `Secure` em HTTPS. O banco guarda só o **SHA-256** do token em `sessions.id`, com expiração (`SESSION_TTL_HOURS`).
- Cada requisição resolve a sessão com join em `users` e `organizations` e monta o `AuthContext` com perfil e unidade **atuais**. A resolução é memoizada por requisição.
- Logout apaga a sessão. `revokeUserSessions` apaga todas as sessões de um usuário. O glue com Next.js (`cookies()`, redirects) fica isolado em `src/server/auth/session.ts`; os serviços não dependem dele.

## Consequências

- Revogação imediata e permissões sempre atuais. Um vazamento do banco não expõe tokens utilizáveis.
- Uma consulta ao banco por requisição autenticada (barata, por chave primária).
- MFA, SSO, recuperação de senha e gestão de sessões não vêm prontos (pendentes; ver [SECURITY.md](../SECURITY.md)).
- O limite de tentativas de login é em memória por processo (pendente: armazenamento compartilhado).

## Alternativas consideradas

- **JWT sem estado**: revogação difícil (lista de bloqueio ou expiração curta mais refresh), claims desatualizadas após mudança de perfil e segredo de assinatura para rotacionar.
- **Auth.js / Better Auth / Lucia**: aceleram SSO e OAuth, mas trazem modelo de dados e convenções próprias. Para e-mail e senha com sessões no banco o ganho era pequeno. Reavaliar ao implementar SSO (SAML/OIDC).
