# ADR-0001 — Stack: Next.js 16 + TypeScript + Tailwind + Radix + Drizzle + PostgreSQL

- **Status**: aceita
- **Data**: 2026-10

## Contexto

O Praetor é a primeira versão funcional de um produto oficial: interface navegável, banco real, regras de acesso por linha e uma camada de IA com processamento em segundo plano. A equipe é pequena e o produto precisa de um único código para interface e servidor, tipagem forte de ponta a ponta e poucas peças de infraestrutura.

## Decisão

- **Next.js 16 (App Router) + React 19 + TypeScript** em um monólito: server components para leitura, server actions para mutações, route handlers para upload e download.
- **Tailwind CSS 4** para estilos e **Radix UI** (dialog, dropdown, tabs, tooltip, select, popover, checkbox, label, slot) para componentes acessíveis, com `class-variance-authority`, `clsx` e `tailwind-merge`. Ícones: `lucide-react`.
- **PostgreSQL** como único armazenamento de estado (dados, fila, sessões), acessado com **Drizzle ORM** (`drizzle-orm` + `drizzle-kit` para migrações SQL versionadas).
- **zod 4** para validar entrada nos serviços, formulários, variáveis de ambiente e a saída da IA.
- **Vitest** para testes; **@anthropic-ai/sdk** atrás de uma interface de provedor; `unpdf` e `mammoth` para extração de texto; `@node-rs/argon2` para senhas.

## Consequências

- Um só deploy web, mais um processo worker que reutiliza os mesmos serviços.
- Tipos compartilhados entre schema, serviços e UI. O SQL continua explícito e revisável.
- Dependemos de APIs recentes do Next.js (16.4), que mudam com frequência: `docs/dev/NEXTJS_16_NOTES.md` registra o que usamos, e os agentes devem ler `node_modules/next/dist/docs/`.
- Sem ORM com "mágica" de autorização: a visibilidade é responsabilidade dos serviços ([ADR-0009](0009-row-visibility-in-services.md)).

## Alternativas consideradas

- **API separada (NestJS/Express) + SPA**: mais peças e duplicação de tipos e validação, sem ganho para o escopo atual.
- **Prisma**: bom DX, mas menos controle sobre SQL (índices parciais, `SKIP LOCKED`, subconsultas de escopo) e engine binária extra.
- **MUI/Chakra**: menos controle visual e bundle maior que Radix + Tailwind.
- **MongoDB**: o domínio é relacional (vínculos, escopo por unidade, agregações do dashboard).
