# ADR-0002 — Modelo de renderização do Next.js: `cacheComponents` desativado

- **Status**: aceita
- **Data**: 2026-10

## Contexto

O Next.js 16 oferece `cacheComponents` (cache de componentes, diretiva `use cache`, prerender parcial), em que dados dinâmicos precisam ficar dentro de `<Suspense>` e o cache é explícito. No Praetor **toda** página depende do usuário: permissões, visibilidade por linha, unidade e confidencialidade. Um erro de cache poderia mostrar dados de um usuário a outro.

## Decisão

- `cacheComponents: false` em `next.config.ts`. Usamos o modelo dinâmico clássico: ler `cookies()` (feito por `requirePageContext`) torna a rota dinâmica, renderizada a cada requisição.
- Não usamos a diretiva `use cache`, `unstable_cache` nem `revalidateTag`. Depois de mutações, as ações chamam `revalidatePath`.
- Não exportamos `dynamic`/`revalidate` sem necessidade.
- A autorização é sempre feita na página, ação ou route handler, nunca só no layout: layouts não re-renderizam na navegação.

## Consequências

- Simplicidade e segurança: nenhum dado por usuário fica em cache compartilhado.
- Cada navegação consulta o banco. Para o volume esperado de um departamento jurídico isso é aceitável; os serviços evitam N+1 e usam consultas agregadas.
- `loading.tsx` dá feedback durante a renderização no servidor.

## Alternativas consideradas

- **Habilitar `cacheComponents`** com cache só em dados não sensíveis: ganho pequeno (quase nada é público) e risco de vazamento por chave de cache mal formada. Reavaliar se surgirem páginas públicas ou dados de referência pesados.
