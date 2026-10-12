import { integer, numeric, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import type { IndexSeriesCode } from "@/domain/enums";
import { createdAt, ts, updatedAt } from "./_columns";

/**
 * Séries mensais de índices de correção (P1.7), coletadas AUTOMATICAMENTE na
 * API pública SGS do Banco Central pela rotina `index_series_refresh`. Dados
 * públicos e iguais para todas as organizações: as tabelas não têm
 * `organization_id`. Nenhuma taxa é digitada à mão.
 *
 * O valor atualizado de uma valoração é calculado na leitura
 * (`updatedValue` em `@/modules/indices/math`) e NUNCA gravado.
 */

/** Catálogo das séries e situação da última coleta (cartão em /admin/integracoes). */
export const indexSeries = pgTable("index_series", {
  /** `ipca_e` | `ipca` | `inpc` | `selic` | `tr`. */
  code: text("code").$type<IndexSeriesCode>().primaryKey(),
  name: text("name").notNull(),
  /** Código da série no SGS do Banco Central (conferido no serviço de metadados do SGS). */
  sgsCode: integer("sgs_code").notNull(),
  /** Último mês (`YYYY-MM`) gravado. Null = nenhum mês coletado ainda. */
  lastMonth: text("last_month"),
  /** Última consulta concluída sem erro (com ou sem meses novos). */
  lastFetchedAt: ts("last_fetched_at"),
  /** Última tentativa de consulta (com ou sem sucesso). */
  lastAttemptAt: ts("last_attempt_at"),
  /** Mensagem (pt-BR, sem corpo da resposta) da última falha; limpa no próximo sucesso. */
  lastError: text("last_error"),
  lastErrorAt: ts("last_error_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Taxa mensal de cada índice, como publicada (variação % no mês). Um mês
 * gravado não é reescrito pela coleta; o mês corrente nunca é gravado (a Selic
 * acumulada do mês em curso é parcial).
 */
export const indexSeriesValues = pgTable(
  "index_series_values",
  {
    indexCode: text("index_code")
      .$type<IndexSeriesCode>()
      .notNull()
      .references(() => indexSeries.code),
    /** Mês de referência `YYYY-MM`. */
    month: text("month").notNull(),
    /** Variação percentual no mês (ex.: "0.160000" = 0,16%), exata (numeric). */
    ratePercent: numeric("rate_percent", { precision: 14, scale: 6 }).notNull(),
    /** Origem do dado, ex.: "bcb_sgs:433". */
    source: text("source").notNull(),
    fetchedAt: ts("fetched_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.indexCode, t.month] })],
);
