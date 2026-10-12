# Praetor UI kit (`src/components/ui`)

Design-system primitives for every screen. Import each component from its own
file (`@/components/ui/<file>`). Server components by default; files marked
**client** contain `"use client"` and may only receive serializable props (and
server actions).

Conventions:

- All visible text in pt-BR. Code identifiers in English.
- Color is never the only signal: badges always carry text (+ dot/icon).
- Violet (`tone="ai"`, `ai-*` tokens) is **reserved for AI-generated content**.
- Gold (`gold-*`) is a **brand accent** (logo square, active nav indicator, hearing chips on the calendar) —
  never a status or data color. Use `gold-700`/`gold-800` for gold text; `gold-400`/`gold-500` on white is
  decorative only (≈2:1 contrast).
- Amber striped banner (`.demo-stripes`) = demo environment (fictitious data; preliminary analysis and
  e-mail are simulations).
- Tables are always inside `overflow-x-auto` (built into `<Table>`).
- Forms: `<FormField>` wires `id`, `aria-invalid`, `aria-describedby`, `aria-required`.
- Light theme only. **Dark mode is pending** (tokens live in `src/app/globals.css`).

## Design tokens (Tailwind v4 `@theme` in `src/app/globals.css`)

Brand colors come from the client logo (`public/brand/`): navy **#0B1A2C** (`navy-900`) and gold
**#D4B062** (`gold-400`); also exported as `BRAND_NAVY` / `BRAND_GOLD` from `@/components/brand/logo`.

| Token | Use |
|---|---|
| `bg-canvas` | page background (#f5f6f8) |
| `bg-surface`, `bg-surface-muted` | cards / subtle panels |
| `border-border`, `border-border-strong` | borders (slate-200 / slate-300) |
| `text-foreground`, `text-muted-foreground`, `text-subtle-foreground` | text |
| `navy-50…950` | brand navy scale; `navy-900` = #0B1A2C (brand), `navy-950` = #07111E |
| `gold-50…900` | brand gold scale; `gold-400` = #D4B062 (brand), `gold-700`/`gold-800` text-safe |
| `bg-primary` / `hover:bg-primary-hover` / `active:bg-primary-active`, `text-primary-foreground`, `primary-50…950` | **primary = brand navy #0B1A2C** (hover `navy-800`, active `navy-950`); the `primary-*` scale equals the `navy-*` scale. Buttons, links, selected states |
| `bg-sidebar`, `bg-sidebar-hover`, `bg-sidebar-active`, `border-sidebar-border`, `text-sidebar-foreground`, `text-sidebar-muted`, `text-sidebar-heading`, `sidebar-indicator` | app shell: navy sidebar (#0B1A2C), group headings (`sidebar-heading`), gold active indicator (#D4B062) |
| `brass-300`, `brass-400`, `brass-500`, `brass-600` | **legacy aliases** of the gold scale, kept for existing classes; `brass-600` = text-safe `gold-700` (#7F6227). Prefer `gold-*` in new code |
| `ai-50…900` | AI content only |
| `outline-ring` | focus ring |

Fonts: `font-sans` (Inter) and `font-display` (Cormorant Garamond, brand headings). Contrast pairs
checked for WCAG AA are listed in the header comment of `src/app/globals.css`.

Tones (`@/lib/tones`): `neutral | info | success | warning | alert | danger | primary | ai`.
Ready-made maps: `RISK_TONES`, `PRIORITY_TONES`, `PROCESS_STATUS_TONES`, `OCCURRENCE_STATUS_TONES`,
`CONTRACT_STATUS_TONES`, `OBLIGATION_STATUS_TONES`, `DEADLINE_STATUS_TONES`, `TASK_STATUS_TONES`,
`VALIDATION_STATUS_TONES`, `ANALYSIS_STATUS_TONES`, `ANALYSIS_REVIEW_STATUS_TONES`,
`ALERT_SEVERITY_TONES`, `TEXT_EXTRACTION_STATUS_TONES`.
Module-local tone maps (v2) live next to their module: `VALUATION_STATUS_TONES`, `GUARANTEE_STATUS_TONES`,
`SETTLEMENT_STATUS_TONES`, `INSTALLMENT_STATUS_TONES`, `SNAPSHOT_STATUS_TONES` (`@/modules/contingency/labels`),
`INTAKE_STATUS_TONES` (`@/modules/intake/status`), `EMAIL_STATUS_TONES` (`@/modules/emails/labels`), hearing
status tones (`@/modules/hearings/components/hearing-badges`). Move one to `@/lib/tones` when another module needs it.

## Helpers (`src/lib`, client-safe)

| Module | Exports |
|---|---|
| `utils.ts` | `cn(...classes)` |
| `format.ts` | `formatDate` ("dd/mm/aaaa"; `"YYYY-MM-DD"` never shifts), `formatDateTime`, `formatMonthYear`, `todayISO`, `toISODate`, `addDaysISO`, `daysUntil`, `formatRelativeDays` ("vence hoje"/"vence em 3 dias"/"vencido há 2 dias"), `formatMoneyCents`, `parseMoneyToCents`, `centsToInputValue`, `formatNumber`, `formatPercent`, `formatFileSize`, `pluralize`, `formatDocument`, `maskDocument` (CPF masked, CNPJ formatted), `truncate`, `initials`. "Today" and timestamps use `America/Sao_Paulo` (`APP_TIME_ZONE`) so server and browser agree. |
| `form.ts` | `str`, `strOrNull`, `bool`, `strings`, `int`, `moneyCents`, `lines`, `file`; `FormState` (client-safe twin of `ActionResult`), `fieldError(state, "campo")`, `fieldErrors` |
| `search-params.ts` | `SearchParams`, `param`, `paramList`, `enumParam(sp, key, ENUM)`, `flagParam`, `idParam` (uuid), `pageParam` ("pagina"), `buildHref(base, sp, overrides)`, `hasAnyParam`, `PAGE_PARAM` |
| `options.ts` | `Option`, `optionsFromLabels(LABELS, order?)` |
| `nav.ts` | `NAV_GROUPS` (`{ label, items: { href, label, icon, permissions[] }[] }` — an item is shown when the user has ANY of its permissions; empty groups are hidden), `NAV_ITEMS` (flat list), `isNavActive` (legacy; the shell uses `activeNavHref` from `components/layout/nav-utils.ts`) |
| `tones.ts` | `Tone`, `TONE_CLASSES`, the `*_TONES` maps above |
| `safe-redirect.ts` | `safeNextPath(value)` — internal path or null (open-redirect guard) |

## Layout & typography

| Component | Props | Notes |
|---|---|---|
| `PageHeader` (`page-header`) | `title, description?, actions?, breadcrumbs?: {label, href?}[], meta?` | The page's only `<h1>`. |
| `Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter` (`card`) | `CardHeader actions?`, `CardTitle as?="h2"\|"h3"\|"h4"` | Use `<CardContent className="px-0">` for flush tables. |
| `DescriptionList` (`description-list`) | `items: ({label, value, full?} \| falsy)[], columns?: 1\|2\|3` | Empty values render a muted "Não informado" (never an em dash). |
| `Timeline` (`timeline`) | `items: {id, date, title, description?, badge?, meta?}[], emptyMessage?` | `"YYYY-MM-DD"` shows date; `Date` shows date+time. |
| `Callout` (`callout`) | `tone?: info\|warning\|danger\|success\|ai, title?, icon?, children` | `tone="ai"` for AI disclaimers. |
| `EmptyState` (`empty-state`) | `title, description?, action?, icon?` | |
| `ErrorState` (`error-state`) | `title?, description?, retry?, action?` | `retry` only from client components. |
| `Skeleton, TableSkeleton, CardSkeleton` (`skeleton`) | `TableSkeleton rows?, columns?`; `CardSkeleton lines?` | Wrap in `role="status"` + sr-only text. |
| `StatCard` (`stat-card`) | `label, value, hint?, href?, tone?, icon?` | With `href` the card links to the records behind the indicator ("Ver registros"). |
| `UserAvatar` (`user-avatar`) | `name, size?: sm\|md\|lg, labelled?` | Initials. |

```tsx
<PageHeader
  title="Processos"
  description="Contencioso da organização."
  breadcrumbs={[{ label: "Painel executivo", href: "/dashboard" }, { label: "Processos" }]}
  actions={can(ctx, "process:write") ? <ButtonLink href="/processos/novo"><Plus aria-hidden="true" />Novo processo</ButtonLink> : null}
/>
<StatCard label="Prazos vencidos" value={formatNumber(n)} tone="danger" icon={<CalendarX />} href="/prazos?aba=prazos&situacao=vencidos" />
```

## Actions & forms

| Component | Props | Notes |
|---|---|---|
| `Button` (`button`) | `variant?: primary\|secondary\|outline\|ghost\|destructive\|link, size?: sm\|md\|lg\|icon, asChild?` | Inside a `<form>` a Button without `type` submits. `size="icon"` needs `aria-label`. |
| `ButtonLink` (`button`) | next/link props + `variant?, size?` | `<ButtonLink href="/x" variant="outline">…</ButtonLink>`; `buttonVariants()` for custom elements. |
| `SubmitButton` (`submit-button`, **client**) | Button props + `pendingLabel?` (default "Salvando…") | `useFormStatus` spinner; must be inside the form. |
| `Input` (`input`), `Textarea` (`textarea`) | native props | `fieldClasses` exported for custom controls. |
| `NativeSelect` (`select`) | `options: {value,label}[], placeholder?, placeholderDisabled?` + native props | Server-form friendly; use `defaultValue`. |
| `Checkbox` (`checkbox`) | `label, description?` + native props | Submits "on" → read with `bool(fd, name)`. |
| `Label` (`label`) | `required?` | |
| `FormField` (`form-field`) | `label, htmlFor, hint?, error?: string\|string[], required?, children` | Injects ARIA into the single child; `fieldA11yProps()` for custom children. |
| `FormMessage` (`form-message`) | `state: ActionResult \| null, successFallback?` | Success `role="status"`, error `role="alert"`. |
| `usePreservingSubmit` (`use-preserving-submit`, **client** hook) | `(dispatch: (formData) => void) => onSubmit` | `onSubmit={usePreservingSubmit(formAction)}` next to `action={formAction}`: dispatches the action in a transition **without React's automatic form reset**, so inputs, textareas, checkboxes and `<select>`s keep their values when the action returns an error. `useFormStatus` keeps working; runs only after the browser validation (`required`…) passes. |

Form pattern (client component calling a server action):

```tsx
"use client";
import { useActionState } from "react";
import { usePreservingSubmit } from "@/components/ui/use-preserving-submit";
import { fieldError } from "@/lib/form";
import { createProcessAction } from "@/modules/processes/actions";

export function ProcessForm({ units }: { units: Option[] }) {
  const [state, action] = useActionState(createProcessAction, null);
  // Without it, React resets the form after every action: an error would wipe what was typed.
  const onSubmit = usePreservingSubmit(action);
  return (
    <form action={action} onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
      <FormMessage state={state} className="sm:col-span-2" />
      <FormField label="Número" htmlFor="number" required error={fieldError(state, "number")}>
        <Input name="number" required />
      </FormField>
      <FormField label="Unidade" htmlFor="unitId" error={fieldError(state, "unitId")}>
        <NativeSelect name="unitId" options={units} placeholder="Selecione…" />
      </FormField>
      <div className="sm:col-span-2"><SubmitButton>Salvar</SubmitButton></div>
    </form>
  );
}
```

## Dialogs & tabs

| Component | Props | Notes |
|---|---|---|
| `Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose` (`dialog`, **client**) | `DialogContent size?: sm\|md\|lg, hideClose?` | Radix (focus trap, Esc). |
| `ConfirmDialog` (`confirm-dialog`, **client**) | `action, title, description?, hiddenFields?, children?, trigger?, triggerLabel?, triggerVariant?, triggerSize?, confirmLabel?, pendingLabel?, cancelLabel?, tone?: destructive\|primary` | Wraps a server action `(prev, formData) => ActionResult`; closes on `ok`; on error the extra fields (`children`) keep what was typed (`usePreservingSubmit`). |
| `LinkTabs` (`tabs`) | `tabs: {key, label, href, count?}[], active, label?` | URL-driven (`?aba=`), server-friendly, `aria-current`. |
| `Tabs, TabsList, TabsTrigger, TabsContent` (`tabs`, client) | Radix props | Client-side tabs. |

```tsx
<ConfirmDialog action={deleteContractAction} hiddenFields={{ id: contract.id }}
  title="Excluir contrato?" description="Esta ação não pode ser desfeita." confirmLabel="Excluir" />

<LinkTabs active={aba} tabs={[
  { key: "prazos", label: "Prazos", href: buildHref("/prazos", sp, { aba: "prazos", pagina: null }), count: 12 },
  { key: "tarefas", label: "Tarefas", href: buildHref("/prazos", sp, { aba: "tarefas", pagina: null }) },
]} />
```

## Lists: tables, filters, pagination

| Component | Props | Notes |
|---|---|---|
| `Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption, TableEmpty` (`table`) | `TableRow interactive?`; `TableEmpty colSpan, message?, description?, action?`; `TableCaption visible?` | Give the table an accessible name (`aria-label` or caption). `tableLinkClasses` for the row's main link. |
| `FilterBar` (`filter-bar`) | `basePath, search?, defaultQuery?, searchLabel?, searchPlaceholder?, hiddenFields?, showClear?, id?, children` | GET form: "q" + children + "Filtrar" + "Limpar". Drops "pagina". `id` lets a control outside the bar submit with it (`form` attribute). |
| `FilterSelect` (`filter-bar`) | `name, label, options, defaultValue?, placeholder?="Todos"` | |
| `FilterInput` (`filter-bar`) | `name, label, defaultValue?` + input props | Dates (`de`, `ate`), month (`mes`). |
| `Pagination` (`pagination`) | `page, pageSize, total, basePath, searchParams` | Keeps filters; param `pagina`. |

```tsx
export default async function Page(props: PageProps<"/processos">) {
  const ctx = await requirePageContext("process:read");
  const sp = await props.searchParams;
  const result = await listProcesses(ctx, { q: param(sp, "q"), status: enumParam(sp, "status", PROCESS_STATUSES), page: pageParam(sp) });
  return (
    <>
      <PageHeader title="Processos" />
      <FilterBar basePath="/processos" defaultQuery={param(sp, "q")} searchPlaceholder="Número, título ou parte">
        <FilterSelect name="status" label="Situação" options={optionsFromLabels(PROCESS_STATUS_LABELS)} defaultValue={param(sp, "status")} />
        <FilterSelect name="risco" label="Risco" options={optionsFromLabels(RISK_LEVEL_LABELS)} defaultValue={param(sp, "risco")} />
      </FilterBar>
      <Card className="py-0">
        <Table aria-label="Processos">
          <TableHeader><TableRow><TableHead>Número</TableHead><TableHead>Risco</TableHead></TableRow></TableHeader>
          <TableBody>
            {result.items.length === 0 ? <TableEmpty colSpan={2} message="Nenhum processo encontrado." /> : result.items.map((p) => (
              <TableRow key={p.id} interactive>
                <TableCell><Link href={`/processos/${p.id}`} className={tableLinkClasses}>{p.number}</Link></TableCell>
                <TableCell><RiskBadge level={p.riskLevel} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/processos" searchParams={sp} />
    </>
  );
}
```

## Badges

| Component | Props | Output |
|---|---|---|
| `Badge` (`badge`) | `tone?, dot?, icon?` + span props | Base pill. |
| `StatusBadge` (`status-badge`) | `label, tone?` | `<StatusBadge label={PROCESS_STATUS_LABELS[s]} tone={PROCESS_STATUS_TONES[s]} />` |
| `RiskBadge` (`risk-badge`) | `level: RiskLevel \| null, withPrefix?` | "Alto" (sr: "Risco Alto") / "Risco alto"; null → "Não classificado". |
| `PriorityBadge` (`priority-badge`) | `priority: Priority \| null, withPrefix?` | low=slate, medium=amber, high=orange, urgent=red. |
| `OriginBadge` (`origin-badge`) | `origin: DataOrigin, validationStatus?` | "Cadastro manual" / "Importado" / "Sugerido pela IA" (violet ✦) / "Gerado pelo sistema"; `ai_suggested` + `pending_validation` → "Sugerido pela IA · aguardando validação". |
| `AiModeBadge` (`ai-mode-badge`) | `mode: AiMode` | demo → amber "Modo demonstrativo"; live → violet "IA". |

## App shell (`src/components/layout`)

Composed by `src/app/(app)/layout.tsx`, which loads the shell data on the server and filters the
menu by permission; module pages only render their content inside `<main id="conteudo">` (max width 7xl, padded).

| Component / helper | File | Notes |
|---|---|---|
| `Sidebar`, `SidebarContent`, `Brand` | `sidebar.tsx` | Take `groups: ShellNavGroup[]` (`{ label: string \| null; items: { href, label, icon: ReactNode }[] }`, already filtered) and an optional `footer`. Navy sidebar (`bg-sidebar`), desktop from `lg`. |
| `SidebarNav` | `sidebar-nav.tsx` (**client**) | Grouped navigation with section headings; exactly one active item = the **longest** matching href (`activeNavHref`). |
| `NavLink` | `nav-link.tsx` (client) | `aria-current` + gold indicator for the active item. |
| `MobileNav` | `mobile-nav.tsx` (client) | Radix Dialog drawer below `lg`; closes when a link is activated. |
| `GlobalSearch` | `global-search.tsx` (client) | GET form to `/busca?q=` (works without JS); `/` or Ctrl/⌘+K focuses it. |
| `AlertsBell`, `SimulatedEmailBadge`, `AiModeIndicator` | `header-indicators.tsx` | Bell with open/critical counts → `/alertas` and `/alertas?severidade=critical`; "E-mail simulado" badge → `/emails` (only with `email:read`); AI mode badge → `/ia`. |
| `UserMenu` | `user-menu.tsx` (client) | Radix dropdown with role, unit, organization and — for external counsel — the law firm; "Sair". |
| `DemoBanner`, `SkipLink` | `demo-banner.tsx`, `skip-link.tsx` | Banner only in demo organizations. |
| `loadShellData(ctx)` | `shell-data.ts` (**server only**, no `next/*`) | Organization, unit, law firm name, alert counts (row-scoped), AI mode, e-mail mode. Never import from client components. |
| `filterNavGroups`, `activeNavHref`, `matchesNavHref` | `nav-utils.ts` (pure) | Permission filtering (ANY permission; empty groups dropped) and active-item matching. |
| `formatBadgeCount`, `alertsBellLabel` | `shell-format.ts` | Badge text and accessible label of the bell. |

The bell count is rendered by the layout, which does not re-render on client navigation: it updates
after an action that revalidates the page, or on reload.

Brand (`src/components/brand`):

| Component | Notes |
|---|---|
| `LogoMark` | Symbol only (arch + square); `variant: "color" \| "light" \| "mono"`, `animated` (motion-safe trace). |
| `LogoWordmark` | Horizontal wordmark from the official paths (`wordmark-paths.ts`, generated by `node scripts/generate-icons.mjs` from `public/brand/praetor-logo.svg`); size by height (`h-6 w-auto`). |
| `LogoBadge` | Navy tile with white arch and gold square (same artwork as the favicon). |
| `Logo` | Wordmark for headers: `tone: "dark" \| "light"` (background it sits on), `size: "sm" \| "md" \| "lg"`. |
| `BrandStatusPage` | Full-page frame for 404 and "sem permissão": navy bar with the wordmark, centered card. |

Pass `title` for an accessible name; omit it when the logo is decorative (next to visible text).
`favicon.ico` and `apple-icon.png` are regenerated by the same script after a logo change.

Special files already provided: `(app)/loading.tsx`, `(app)/error.tsx`, `(app)/not-found.tsx`
(use `notFound()` for missing/invisible records), root `not-found.tsx` (brand frame), `global-error.tsx`,
`/sem-permissao` (target of `requirePageContext(perm)`, brand frame), `/login`, `/busca`, `/api/health`.
Add a segment-level `loading.tsx` only when a screen needs a more specific skeleton.
