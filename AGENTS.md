<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Praetor — agent guide

Praetor is a corporate legal management platform (preventive + litigation) with an AI
analysis layer. Stack: Next.js 16 (App Router, TypeScript), Tailwind CSS 4, Radix UI,
PostgreSQL + Drizzle ORM, zod, Vitest (PGlite), Anthropic SDK behind a provider interface.

Read before changing code:
- `docs/dev/MODULE_CONTRACTS.md` — layout, service conventions, cross-module APIs, URL params.
- `docs/dev/NEXTJS_16_NOTES.md` — Next 16 specifics used here (cacheComponents is OFF).
- `docs/SECURITY.md` and `src/server/auth/access.ts` — row-visibility rules.

## Commands

| Command | Purpose |
|---|---|
| `npm run db:dev` | Start local PostgreSQL (embedded, port 54329) — keep running |
| `npm run db:setup` | Apply migrations + seed demo data |
| `npm run dev` | Web (Next dev) + background worker |
| `npm run db:generate -- --name <change>` | Generate a migration after editing `src/server/db/schema/*` |
| `npm run typecheck` | `next typegen && tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test` | Vitest (in-memory PGlite, no server needed) |
| `npm run build` | Production build |
| `npm run validate` | All of the above in order — run before handing work back |

## Non-negotiable conventions

1. **Language**: identifiers, file names, DB columns and enum ids in English; every user-facing
   string in Brazilian Portuguese. Enum labels live in `src/domain/enums.ts`.
2. **Authorization on the server**: every page calls `requirePageContext(perm)`, every server
   action `requireActionContext(perm)`, every route handler `getCurrentUser()`; every service
   checks `assertCan` and applies the row-visibility `*Where(ctx)` from `src/server/auth/access.ts`.
   Hiding a button is never authorization.
3. **Tenant isolation**: never take `organizationId` from input; validate every foreign id belongs to
   `ctx.organizationId`.
4. **Layers**: `src/app` (routes) → `src/modules/<domain>/actions.ts` → `service.ts` → `src/server/db`.
   Services never import `next/*` or `@/server/auth/session`. Client components never import
   `@/server/*` or `service.ts`.
5. **Audit** relevant mutations with `recordAudit` inside the transaction. Never log or audit
   document contents, extracted text, prompts or AI answers.
6. **AI**: document text is untrusted data; it is only sent inside delimited source blocks via
   `src/server/integrations/ai`. AI output never changes records directly — suggestions become
   tasks/deadlines only through an explicit user action, and AI-suggested deadlines require
   human validation. Demo-mode output must always be labeled as demonstrative.
7. **No fabrication**: do not invent case law, citations, court movements or tribunal
   integrations. Seed data is fictional and labeled as such.
8. **Schema changes**: edit `src/server/db/schema/*`, run `npm run db:generate`, commit the SQL in
   `drizzle/`. Never edit an applied migration.
9. Keep `docs/STATUS.md` (implemented / simulated / pending) up to date when adding features.
