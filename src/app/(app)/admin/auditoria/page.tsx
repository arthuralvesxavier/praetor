import { Download, EyeOff, ScrollText } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterInput, FilterSelect } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  tableLinkClasses,
} from "@/components/ui/table";
import { entityHref, type EntityRef } from "@/domain/entities";
import { ENTITY_TYPE_LABELS, ENTITY_TYPES, type EntityType } from "@/domain/enums";
import { formatDateTime, formatNumber } from "@/lib/format";
import { optionsFromLabels } from "@/lib/options";
import { buildHref, enumParam, hasAnyParam, idParam, pageParam, param, type SearchParams } from "@/lib/search-params";
import { AdminNav } from "@/modules/admin/components/admin-nav";
import { ChangeList } from "@/modules/admin/components/change-list";
import { actionLabel } from "@/modules/admin/history-format";
import { AUDIT_EXPORT_MAX_ROWS, listAllUserOptions, listAuditActions, listAuditLogs } from "@/modules/admin/service";
import { requirePageContext } from "@/server/auth/session";

export const metadata: Metadata = { title: "Auditoria" };

const FILTER_KEYS = ["acao", "entidade", "usuario", "de", "ate"] as const;

const RECORD_TYPES: readonly EntityType[] = ["legal_process", "occurrence", "contract", "document", "task", "deadline", "analysis"];

/** Access to confidential processes is recorded with this action (RF-22 / TE-10). */
const CONFIDENTIAL_ACCESS_ACTION = "legal_process.view_confidential";

function dateParam(sp: SearchParams, key: string): string | undefined {
  const v = param(sp, key);
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : undefined;
}

function actionParam(sp: SearchParams): string | undefined {
  const v = param(sp, "acao");
  return v && v.length <= 100 && /^[a-z0-9_.]+$/.test(v) ? v : undefined;
}

function entityLink(type: EntityType, id: string | null): string | null {
  if (!id) return type === "organization" ? "/admin/configuracoes" : null;
  if (RECORD_TYPES.includes(type)) return entityHref({ type: type as EntityRef["type"], id });
  if (type === "user") return `/admin/usuarios/${id}`;
  if (type === "team") return `/admin/equipes/${id}`;
  if (type === "unit") return `/admin/unidades/${id}`;
  if (type === "company") return `/admin/empresas/${id}`;
  if (type === "law_firm") return `/admin/escritorios/${id}`;
  if (type === "case_brief") return `/analises-preliminares/${id}`;
  if (type === "intake") return `/entrada/${id}`;
  if (type === "email") return `/emails/${id}`;
  if (type === "import_batch") return `/importacoes/${id}`;
  if (type === "organization") return "/admin/configuracoes";
  return null;
}

export default async function AuditPage(props: PageProps<"/admin/auditoria">) {
  const ctx = await requirePageContext("audit:read");
  const sp = await props.searchParams;
  let from = dateParam(sp, "de");
  let to = dateParam(sp, "ate");
  if (from && to && from > to) [from, to] = [to, from];

  const [result, actions, actors] = await Promise.all([
    listAuditLogs(ctx, {
      action: actionParam(sp),
      entityType: enumParam(sp, "entidade", ENTITY_TYPES),
      actorId: idParam(sp, "usuario"),
      from,
      to,
      page: pageParam(sp),
    }),
    listAuditActions(ctx),
    listAllUserOptions(ctx),
  ]);
  const filtered = hasAnyParam(sp, FILTER_KEYS);
  const actionFilter = actionParam(sp);
  const confidentialOnly = actionFilter === CONFIDENTIAL_ACCESS_ACTION;
  const actionOptions = actions.includes(CONFIDENTIAL_ACCESS_ACTION) ? actions : [...actions, CONFIDENTIAL_ACCESS_ACTION].sort();
  const exportHref = buildHref("/admin/auditoria/exportar", sp, { pagina: null });

  return (
    <>
      <PageHeader
        title="Auditoria"
        description="Trilha das ações relevantes: cadastros, alterações, exclusões, envios e downloads de documentos, análises de IA, validações, acessos e mudanças administrativas."
        breadcrumbs={[{ label: "Administração", href: "/admin" }, { label: "Auditoria" }]}
        actions={
          result.total > 0 ? (
            <ButtonLink
              href={exportHref}
              variant="outline"
              prefetch={false}
              download
              title={`Exporta a trilha com os filtros aplicados (até ${formatNumber(AUDIT_EXPORT_MAX_ROWS)} registros)`}
            >
              <Download aria-hidden="true" />
              Exportar CSV
            </ButtonLink>
          ) : null
        }
      />
      <AdminNav ctx={ctx} active="auditoria" />

      <Callout tone="info" className="mb-4">
        A trilha não armazena conteúdo de documentos, textos extraídos, perguntas ou respostas da IA nem senhas — apenas o
        registro de que a ação ocorreu e os campos alterados (textos longos aparecem resumidos).
      </Callout>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Atalhos:</span>
        <ButtonLink
          href={confidentialOnly ? buildHref("/admin/auditoria", sp, { acao: null, pagina: null }) : buildHref("/admin/auditoria", sp, { acao: CONFIDENTIAL_ACCESS_ACTION, pagina: null })}
          variant={confidentialOnly ? "secondary" : "outline"}
          size="sm"
          aria-current={confidentialOnly ? "true" : undefined}
        >
          <EyeOff aria-hidden="true" />
          {confidentialOnly ? "Mostrando acessos a processos sigilosos — remover filtro" : "Acessos a processos sigilosos"}
        </ButtonLink>
      </div>

      <FilterBar basePath="/admin/auditoria" search={false} showClear={filtered}>
        <FilterSelect
          name="acao"
          label="Ação"
          options={actionOptions.map((a) => ({ value: a, label: actionLabel(a) === a ? a : `${actionLabel(a)} (${a})` }))}
          defaultValue={param(sp, "acao")}
          placeholder="Todas"
        />
        <FilterSelect
          name="entidade"
          label="Entidade"
          options={optionsFromLabels(ENTITY_TYPE_LABELS)}
          defaultValue={param(sp, "entidade")}
          placeholder="Todas"
        />
        <FilterSelect
          name="usuario"
          label="Usuário"
          options={actors.map((u) => ({ value: u.id, label: u.isActive ? u.name : `${u.name} (inativo)` }))}
          defaultValue={param(sp, "usuario")}
        />
        <FilterInput name="de" label="De" type="date" defaultValue={from} />
        <FilterInput name="ate" label="Até" type="date" defaultValue={to} />
      </FilterBar>

      {result.total === 0 && !filtered ? (
        <EmptyState icon={<ScrollText />} title="Nenhuma ação registrada" description="As ações relevantes aparecerão aqui." />
      ) : (
        <>
          <Card className="py-0">
            <Table aria-label="Trilha de auditoria">
              <TableHeader>
                <TableRow>
                  <TableHead>Data/hora</TableHead>
                  <TableHead>Usuário</TableHead>
                  <TableHead>Ação</TableHead>
                  <TableHead>Entidade</TableHead>
                  <TableHead>Resumo</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.items.length === 0 ? (
                  <TableEmpty
                    colSpan={6}
                    message={
                      confidentialOnly
                        ? "Nenhum acesso a processo sigiloso registrado com estes filtros."
                        : "Nenhuma ação encontrada com estes filtros."
                    }
                  />
                ) : (
                  result.items.map((entry) => {
                    const href = entityLink(entry.entityType, entry.entityId);
                    const entityLabel = ENTITY_TYPE_LABELS[entry.entityType] ?? entry.entityType;
                    const changeCount = entry.changes ? Object.keys(entry.changes).length : 0;
                    return (
                      <TableRow key={entry.id} className="align-top">
                        <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(entry.createdAt)}</TableCell>
                        <TableCell>{entry.actorName ?? <span className="text-muted-foreground">Sistema</span>}</TableCell>
                        <TableCell>
                          <span className="block">{actionLabel(entry.action)}</span>
                          <code className="text-xs text-muted-foreground">{entry.action}</code>
                        </TableCell>
                        <TableCell>
                          {href ? (
                            <Link href={href} className={tableLinkClasses}>
                              {entityLabel}
                            </Link>
                          ) : (
                            entityLabel
                          )}
                        </TableCell>
                        <TableCell className="min-w-64">
                          <span>{entry.summary}</span>
                          {changeCount > 0 ? (
                            <details className="mt-1 group">
                              <summary className="cursor-pointer text-xs font-medium text-primary-700 hover:underline">
                                Ver {changeCount === 1 ? "1 campo alterado" : `${changeCount} campos alterados`}
                              </summary>
                              <ChangeList changes={entry.changes} entityType={entry.entityType} names={entry.refNames} className="text-xs" />
                            </details>
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{entry.ipAddress ?? "—"}</TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
          <Pagination page={result.page} pageSize={result.pageSize} total={result.total} basePath="/admin/auditoria" searchParams={sp} />
        </>
      )}
    </>
  );
}
