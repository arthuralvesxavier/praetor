import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import type { BiRefreshStatus, BiRefreshTrigger } from "@/domain/enums";
import { createdAt, id, ts, updatedAt } from "./_columns";
import { organizations, users } from "./core";
import { legalProcesses } from "./legal";

/**
 * Painéis Power BI (docs/POWER_BI.md). O Power BI lê SOMENTE as views do schema
 * `bi` (migração `bi_reporting_views`), com o usuário de banco somente leitura
 * `praetor_bi` (scripts/bi-setup.ts). As tabelas abaixo ficam no schema público
 * e são escritas apenas pelo Praetor. Segredos do Azure ficam só no ambiente.
 */

/** Relatório publicado no Power BI que o Praetor incorpora em /paineis-bi. */
export type BiReportConfig = { id: string; name: string; datasetId: string };

/**
 * Configuração (uma linha por organização) e estado da atualização automática.
 * As colunas de configuração são escritas pela tela de administração; as de
 * estado (`access_*`, `source_watermark_at`), pela rotina `bi_access_refresh`.
 */
export const biSettings = pgTable("bi_settings", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id),
  /** Workspace (grupo) do Power BI onde os relatórios foram publicados. */
  workspaceId: text("workspace_id"),
  reports: jsonb("reports").$type<BiReportConfig[]>().notNull().default([]),
  /** Papel de segurança por linha (RLS) do conjunto de dados, com o filtro [user_key] = USERNAME(). */
  rlsRole: text("rls_role").notNull().default("AcessoPraetor"),
  /** Solicita a atualização do conjunto de dados após importações, fechamentos e coletas. */
  autoRefresh: boolean("auto_refresh").notNull().default(true),
  configUpdatedAt: ts("config_updated_at"),
  configUpdatedById: uuid("config_updated_by_id").references(() => users.id),
  /** Última reconstrução da tabela de acessos (`bi_process_access`). */
  accessRefreshedAt: ts("access_refreshed_at"),
  accessUserCount: integer("access_user_count"),
  accessRowCount: integer("access_row_count"),
  /**
   * Última vez em que a tabela de acessos MUDOU (vínculo incluído ou retirado: sigilo, redistribuição,
   * troca de unidade ou de papel, usuário desativado). Conta como motivo de atualização do Power BI.
   */
  accessChangedAt: ts("access_changed_at"),
  /** Marca d'água: maior data de evento de origem (importação, fechamento, coleta, mudança de acesso) já encaminhada ao Power BI. */
  sourceWatermarkAt: ts("source_watermark_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Processos que cada usuário pode ver, calculados com as MESMAS regras do
 * Praetor (`processWhere(ctx)`), reconstruídos pela rotina `bi_access_refresh`.
 * Exposta como `bi.acesso`; o papel RLS do Power BI filtra `user_key = USERNAME()`.
 */
export const biProcessAccess = pgTable(
  "bi_process_access",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Identidade enviada ao Power BI (effective identity): o id do usuário no Praetor. */
    userKey: text("user_key").notNull(),
    processId: uuid("process_id")
      .notNull()
      .references(() => legalProcesses.id, { onDelete: "cascade" }),
    refreshedAt: ts("refreshed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.processId] }),
    index("bi_process_access_org_idx").on(t.organizationId),
    index("bi_process_access_user_key_idx").on(t.userKey),
  ],
);

/** Histórico das solicitações de atualização do conjunto de dados no Power BI. */
export const biRefreshRuns = pgTable(
  "bi_refresh_runs",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    trigger: text("trigger").$type<BiRefreshTrigger>().notNull(),
    status: text("status").$type<BiRefreshStatus>().notNull(),
    datasetId: text("dataset_id"),
    /** Mensagem pt-BR saneada (nunca tokens, segredos ou dados da carteira). */
    message: text("message"),
    /** Identificador da solicitação devolvido pelo Power BI, quando houver. */
    requestId: text("request_id"),
    requestedById: uuid("requested_by_id").references(() => users.id),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("bi_refresh_runs_org_created_idx").on(t.organizationId, t.createdAt)],
);

/**
 * Rótulos pt-BR dos códigos usados nas views (fase, instância, situação...),
 * sincronizados de `@/domain/enums` pela rotina e por scripts/bi-setup.ts.
 * Exposta como `bi.rotulos`; as views já trazem as colunas `*_rotulo`.
 */
export const biLabels = pgTable(
  "bi_labels",
  {
    domain: text("domain").notNull(),
    code: text("code").notNull(),
    label: text("label").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.domain, t.code] })],
);

/**
 * Escopo dos usuários de banco somente leitura (`praetor_bi` ou `praetor_bi_<sufixo>`,
 * scripts/bi-setup.ts): cada papel lê nas views do schema `bi` apenas as linhas da
 * organização registrada aqui, e só de uma (role_name é a chave; o bi-setup recusa
 * mudar a organização de um papel existente sem --reassign). Papel de leitura sem
 * registro não vê nada (falha fechada); o dono do banco (o próprio Praetor) vê tudo.
 * As views são barreiras de segurança (migração 0011). Escrita só pelo bi-setup.
 */
export const biReaderRoles = pgTable("bi_reader_roles", {
  roleName: text("role_name").primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  createdAt: createdAt(),
});
