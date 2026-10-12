/**
 * Relatórios jurídicos (client-safe, sem I/O): tipos gravados em jsonb e
 * regras de exibição compartilhadas pela tela e pelo PDF.
 *
 * Regras do produto aplicadas aqui:
 * - todo item tem origem declarada (Documentado, Cadastro, Inferência,
 *   Análise, Lacuna); item sem origem bloqueia a emissão;
 * - uma lacuna é exibida literalmente como "[DADO NÃO LOCALIZADO]", nunca
 *   como zero nem vazia;
 * - valor da causa e valor apurado nunca são somados (RN-02): totais só
 *   somam valores da MESMA grandeza (`totalOf`).
 */
import type { LegalReportType, ProbabilityBand, ReportItemOrigin } from "./enums";

/** Texto literal de uma lacuna (nunca zero, nunca vazio). */
export const GAP_MARKER = "[DADO NÃO LOCALIZADO]";

/** Escopo do relatório: processo (R1), período (R2), filtros da carteira (R3) ou responsável (R4). */
export type LegalReportScope = {
  processId?: string | null;
  /** Período de referência (YYYY-MM-DD a YYYY-MM-DD) ou competência YYYY-MM em `from` e `to`. */
  period?: { from: string; to: string } | null;
  filters?: Record<string, string | string[]> | null;
  responsibleId?: string | null;
};

export type ProbabilityBandRange = { min: number; max: number };
export type ProbabilityBands = Record<ProbabilityBand, ProbabilityBandRange>;

/** Parâmetros congelados na geração (o relatório aprovado é reproduzível). */
export type LegalReportParameters = {
  /** Gerador que montou o conteúdo (registrado em `GENERATORS` do módulo). */
  generator: string;
  generatorVersion: number;
  confidenceThreshold: number;
  bands: ProbabilityBands;
  legalBasisText: string;
  subtitle: string | null;
  /** Seções na ordem do relatório. */
  sections: { key: string; title: string }[];
  /** Nota metodológica (parágrafos) gerada a partir dos dados. */
  methodology: string[];
  /** Rótulo do escopo para capa e listas (ex.: número do processo). */
  scopeLabel: string;
};

/**
 * A que se refere a data de `RecordSource.recordedAt`:
 * - `record`: data do registro lido (última atualização, oficialização ou criação);
 * - `latest`: registro mais recente entre as várias linhas lidas (lista, tabela);
 * - `query`: a consulta não encontrou nenhum registro; a data é a da consulta.
 */
export const RECORD_DATE_BASES = ["record", "latest", "query"] as const;
export type RecordDateBasis = (typeof RECORD_DATE_BASES)[number];

/** Onde um dado de cadastro foi lido (tabela, campo e data do registro). */
export type RecordSource = {
  table: string;
  field: string;
  recordId: string | null;
  /** Descrição em pt-BR (ex.: "Cadastro do processo, campo Tribunal"). */
  label: string;
  /**
   * Data do registro (ISO) ou data-base (YYYY-MM-DD). OBRIGATÓRIA para itens de
   * cadastro e de análise (a validação bloqueia a emissão sem ela); null só em
   * relatórios gravados antes da regra.
   */
  recordedAt: string | null;
  /** A que se refere `recordedAt` (padrão: `record`). */
  dateBasis?: RecordDateBasis;
};

/** Chave da sequência de referências: tipo oficial ou série própria do documento de teste do motor. */
export type LegalReportSequenceKey = LegalReportType | `sample:${LegalReportType}`;

/** Grandezas monetárias que um relatório pode totalizar (nunca entre si). */
export const MONEY_QUANTITIES = ["claim", "liquidated", "guarantee", "exposure", "provision"] as const;
export type MoneyQuantity = (typeof MONEY_QUANTITIES)[number];
export const MONEY_QUANTITY_LABELS: Record<MoneyQuantity, string> = {
  claim: "Valor da causa",
  liquidated: "Valor apurado",
  guarantee: "Garantias vinculadas",
  exposure: "Exposição líquida",
  provision: "Provisão",
};

export type ReportTableColumn = {
  header: string;
  align?: "left" | "right" | "center";
  /** Peso relativo da largura. */
  weight?: number;
  /** Texto de uma célula nula nesta coluna (padrão: GAP_MARKER). Nunca "0" nem vazio. */
  nullLabel?: string;
  /** Coluna monetária: grandeza (para o total da coluna). */
  quantity?: MoneyQuantity;
};

/** Conteúdo estruturado de um item (tabela de dados com a origem do item). */
export type ReportItemData = {
  kind: "table";
  columns: ReportTableColumn[];
  /** Células já formatadas; null = dado ausente (exibido com `nullLabel`). */
  rows: (string | null)[][];
  /** Linha de totais (já formatada), quando houver. */
  totals: (string | null)[] | null;
  note: string | null;
};

/** Item ainda não gravado, produzido por um gerador. `origin` ausente é erro de validação. */
export type ReportItemDraft = {
  /** Identificador local (referências de inferência usam esta chave). */
  key: string;
  section: string;
  content: string;
  origin?: ReportItemOrigin | null;
  documentId?: string | null;
  documentVersionId?: string | null;
  page?: number | null;
  /** Trecho literal da página citada. */
  excerpt?: string | null;
  /**
   * Hash (SHA-256) da versão lida pelo gerador. OBRIGATÓRIO para item documentado
   * (sem ele a emissão é bloqueada); o verificador sempre compara com o atual.
   */
  documentSha256?: string | null;
  recordSource?: RecordSource | null;
  /** Chaves dos itens dos quais esta inferência deriva. */
  derivedFrom?: string[] | null;
  /** Confiança de 0 a 100 (null = não se aplica). */
  confidence?: number | null;
  simulated?: boolean;
  data?: ReportItemData | null;
};

export type LegalReportDraft = {
  type: LegalReportType;
  title: string;
  subtitle: string | null;
  scope: LegalReportScope;
  scopeLabel: string;
  baseDate: string;
  isSample: boolean;
  generator: string;
  generatorVersion: number;
  sections: { key: string; title: string }[];
  methodology: string[];
  items: ReportItemDraft[];
};

/** Texto exibido de um item: lacunas mostram o marcador literal, nunca um valor. */
export function itemDisplayText(item: { origin: ReportItemOrigin | null | undefined; content: string }): string {
  if (item.origin === "gap") {
    const label = item.content.trim().replace(/[:\s]+$/, "");
    return label ? `${label}: ${GAP_MARKER}` : GAP_MARKER;
  }
  return item.content;
}

/** Texto de uma célula de tabela: nulo vira o rótulo explícito da coluna (nunca "0" nem vazio). */
export function cellDisplayText(value: string | null | undefined, column: Pick<ReportTableColumn, "nullLabel">): string {
  if (value === null || value === undefined || value.trim() === "") return column.nullLabel?.trim() || GAP_MARKER;
  return value;
}

export type MoneyValue = { quantity: MoneyQuantity; cents: number | null };
export type MoneyTotal = { quantity: MoneyQuantity; cents: number; counted: number; unknown: number };

/**
 * Total de UMA grandeza (RN-02/RN-03): nulos são contados como desconhecidos,
 * nunca como zero; um valor de outra grandeza é erro de programação (valor da
 * causa e valor apurado nunca são somados).
 */
export function totalOf(values: readonly MoneyValue[], quantity: MoneyQuantity): MoneyTotal {
  const total: MoneyTotal = { quantity, cents: 0, counted: 0, unknown: 0 };
  for (const v of values) {
    if (v.quantity !== quantity) {
      throw new Error(`Grandezas diferentes não são somadas: ${v.quantity} em total de ${quantity}.`);
    }
    if (v.cents === null || !Number.isFinite(v.cents)) total.unknown += 1;
    else {
      total.cents += v.cents;
      total.counted += 1;
    }
  }
  return total;
}

/** Faixa de probabilidade que contém o percentual (limites inclusivos; a faixa mais alta vence no empate). */
export function bandForPercent(bands: ProbabilityBands, percent: number): ProbabilityBand | null {
  const order: ProbabilityBand[] = ["very_high", "high", "moderate", "low", "very_low"];
  for (const band of order) {
    const r = bands[band];
    if (percent >= r.min && percent <= r.max) return band;
  }
  return null;
}
