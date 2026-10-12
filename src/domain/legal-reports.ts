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

/**
 * Disposição das partes fixas do relatório:
 * - `standard`: nota metodológica (1), seções (2…), pendências, fontes e não confirmado;
 * - `process_report` (R1): capa de identificação (1), nota metodológica (2), demais
 *   seções (3…), auditoria de fontes (verificado e não confirmado) e pendências por último.
 */
/** Seção do relatório; `note` é um texto fixo (ressalva) exibido ao fim da seção, sem selo de origem. */
export type ReportSectionSpec = { key: string; title: string; note?: string | null };

export const LEGAL_REPORT_LAYOUTS = ["standard", "process_report"] as const;
export type LegalReportLayout = (typeof LEGAL_REPORT_LAYOUTS)[number];

/** Parâmetros congelados na geração (o relatório aprovado é reproduzível). */
export type LegalReportParameters = {
  /** Gerador que montou o conteúdo (registrado em `GENERATORS` do módulo). */
  generator: string;
  generatorVersion: number;
  confidenceThreshold: number;
  bands: ProbabilityBands;
  legalBasisText: string;
  subtitle: string | null;
  /** Seções na ordem do relatório (`note`: texto fixo exibido ao fim da seção). */
  sections: ReportSectionSpec[];
  /** Nota metodológica (parágrafos) gerada a partir dos dados. */
  methodology: string[];
  /** Rótulo do escopo para capa e listas (ex.: número do processo). */
  scopeLabel: string;
  /** Disposição das partes fixas (ausente = `standard`, relatórios gravados antes do R1). */
  layout?: LegalReportLayout;
  /** Finalidade declarada na capa (R1). */
  purpose?: string | null;
  /** Versão do sistema que gerou o relatório ("Elaborado por"). */
  appVersion?: string | null;
  /**
   * Impressão digital (SHA-256) dos dados do escopo lidos na geração: a rotina de
   * atualização compara com a atual para decidir se há dado novo (R1).
   */
  dataFingerprint?: string | null;
  /**
   * Permissões de leitura dos módulos cujo conteúdo o relatório traz (ex.:
   * `brief:read` quando há itens da análise preliminar, `deadline:read` com
   * prazos). Quem não tem todas não vê o relatório (`legalReportWhere`), como
   * acontece com documento citado fora do acesso. Ausente = só processo e documentos.
   */
  requiredPermissions?: string[] | null;
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

/** Conteúdo estruturado de um item: tabela de dados com a origem do item. */
export type ReportTableData = {
  kind: "table";
  columns: ReportTableColumn[];
  /** Células já formatadas; null = dado ausente (exibido com `nullLabel`). */
  rows: (string | null)[][];
  /** Linha de totais (já formatada), quando houver. */
  totals: (string | null)[] | null;
  note: string | null;
};

/**
 * Item que é UMA linha de uma tabela: itens consecutivos da mesma seção com o
 * mesmo `group` são exibidos juntos, numa tabela com a coluna de origem (selo)
 * de cada linha (ex.: linha do tempo com eventos de cadastro e de documentos).
 * Cada linha continua sendo um item: tem origem própria, passa pela conferência
 * de fontes e, se não for afirmada, vai para as pendências.
 */
export type ReportRowData = {
  kind: "row";
  group: string;
  /** Título da tabela do grupo (lido da primeira linha do grupo). */
  caption?: string | null;
  /** Colunas do grupo (iguais em todas as linhas do grupo). */
  columns: ReportTableColumn[];
  /** Células já formatadas; null = dado ausente (exibido com `nullLabel`). */
  cells: (string | null)[];
};

export type ReportItemData = ReportTableData | ReportRowData;

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
  /**
   * Só no rascunho (não gravado): chaves das lacunas do relatório cujo marcador
   * este item repete no texto (ex.: a síntese repete "valor apurado
   * [DADO NÃO LOCALIZADO]" da lacuna da seção de valores). Todo marcador no texto
   * de um item que não é lacuna precisa de uma referência (ou de uma célula vazia
   * do próprio item): assim todo dado não localizado consta das pendências.
   */
  gapRefs?: string[] | null;
  /**
   * Só no rascunho: inferência que resume lacunas (afirma a ausência dos dados).
   * Não vai para as pendências por derivar apenas de lacunas.
   */
  summarizesGaps?: boolean;
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
  sections: ReportSectionSpec[];
  methodology: string[];
  items: ReportItemDraft[];
  /** Disposição das partes fixas (padrão: `standard`). */
  layout?: LegalReportLayout;
  /** Finalidade declarada na capa. */
  purpose?: string | null;
  /** Impressão digital dos dados do escopo (ver `LegalReportParameters.dataFingerprint`). */
  dataFingerprint?: string | null;
  /** Permissões de leitura exigidas de quem vê o relatório (ver `LegalReportParameters.requiredPermissions`). */
  requiredPermissions?: string[] | null;
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

function isEmptyCell(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/** Coluna em que a célula vazia é uma lacuna (exibida como o marcador literal). */
export function isGapColumn(column: Pick<ReportTableColumn, "nullLabel">): boolean {
  return (column.nullLabel?.trim() || GAP_MARKER) === GAP_MARKER;
}

/** Quantas vezes o marcador de lacuna aparece num texto. */
export function countGapMarkers(text: string | null | undefined): number {
  return text ? text.split(GAP_MARKER).length - 1 : 0;
}

/** Células vazias de colunas de lacuna (linha de tabela ou tabela inteira). */
export function emptyGapCellCount(data: ReportItemData | null | undefined): number {
  if (!data) return 0;
  const count = (cells: readonly (string | null)[]) =>
    cells.filter((cell, i) => !!data.columns[i] && isGapColumn(data.columns[i]) && isEmptyCell(cell)).length;
  return data.kind === "row" ? count(data.cells) : data.rows.reduce((n, r) => n + count(r), 0);
}

/** Identificação curta de uma linha de tabela (primeira célula preenchida, fora a da lacuna). */
function rowLabel(cells: readonly (string | null)[], skip: number): string | null {
  for (const [i, cell] of cells.entries()) {
    if (i === skip || cell === null || isEmptyCell(cell)) continue;
    const first = cell.split("\n")[0].replace(/\s+/g, " ").trim();
    return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first;
  }
  return null;
}

/**
 * Dados não localizados de um item, cada um com o marcador literal: a própria
 * lacuna, ou cada célula vazia de coluna de lacuna (com a coluna e a linha).
 * É a lista de "Dados não localizados" das pendências e a contagem da nota
 * metodológica (as duas usam esta função). Um marcador repetido no texto de outro
 * item (`gapRefs` do rascunho) não entra de novo: o dado já está listado.
 */
export function itemGapLabels(item: {
  origin?: ReportItemOrigin | null;
  content: string;
  data?: ReportItemData | null;
}): string[] {
  if (item.origin === "gap") return [itemDisplayText({ origin: "gap", content: item.content })];
  const data = item.data;
  if (!data) return [];
  const out: string[] = [];
  const scan = (cells: readonly (string | null)[]) => {
    cells.forEach((cell, i) => {
      const column = data.columns[i];
      if (!column || !isGapColumn(column) || !isEmptyCell(cell)) return;
      const who = rowLabel(cells, i);
      out.push(`${column.header}${who ? ` (${who})` : ""}: ${GAP_MARKER}`);
    });
  };
  if (data.kind === "row") scan(data.cells);
  else data.rows.forEach(scan);
  return out;
}

// ---------------------------------------------------------------------------
// Minimização de dados: CPF e CNPJ não aparecem no relatório
// ---------------------------------------------------------------------------

export const CPF_OMITTED = "[CPF omitido]";
export const CNPJ_OMITTED = "[CNPJ omitido]";

function digitsOf(value: string): number[] {
  return value
    .replace(/\D/g, "")
    .split("")
    .map(Number);
}

function checkDigit(digits: readonly number[], weights: readonly number[]): number {
  const r = weights.reduce((acc, w, i) => acc + w * digits[i], 0) % 11;
  return r < 2 ? 0 : 11 - r;
}

/** CPF com dígitos verificadores válidos (11 algarismos, não todos iguais). */
export function isValidCpf(value: string): boolean {
  const d = digitsOf(value);
  if (d.length !== 11 || d.every((x) => x === d[0])) return false;
  return checkDigit(d, [10, 9, 8, 7, 6, 5, 4, 3, 2]) === d[9] && checkDigit(d, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === d[10];
}

/** CNPJ com dígitos verificadores válidos (14 algarismos, não todos iguais). */
export function isValidCnpj(value: string): boolean {
  const d = digitsOf(value);
  if (d.length !== 14 || d.every((x) => x === d[0])) return false;
  return (
    checkDigit(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === d[12] &&
    checkDigit(d, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === d[13]
  );
}

/** Sigla seguida do número ("CPF 123...", "CNPJ/MF nº 12..."). */
const LABELED_ID_RE =
  /\b(CPF|CNPJ)(\s*(?:\/\s*MF)?\s*(?:n[º°o]?\.?|:|-)?\s*)(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}|\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?![\d\/])/gi;
const CNPJ_FORMATTED_RE = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g;
const CPF_FORMATTED_RE = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
/** 11 ou 14 algarismos seguidos, isolados (fora de números maiores, como o CNJ sem pontuação, e de códigos com letras). */
const BARE_DIGITS_RE = /(?<![\w.\/-])(\d{14}|\d{11})(?![\w\/-]|\.\d)/g;

/**
 * Substitui CPF e CNPJ por "[CPF omitido]" e "[CNPJ omitido]": números no
 * formato usual (000.000.000-00, 00.000.000/0000-00), números depois da sigla
 * (CPF ou CNPJ seguido do número) e sequências de 11 ou 14 algarismos com
 * dígitos verificadores válidos. Vale para todo texto livre gravado no relatório
 * (itens, células, notas, fontes); trechos literais de documento não são
 * alterados: o gerador não cita trecho que contenha esses números (`containsPersonalId`).
 */
export function redactPersonalIds(text: string): string {
  return text
    .replace(LABELED_ID_RE, (_match: string, label: string, sep: string, number: string) =>
      `${label}${sep}${digitsOf(number).length === 11 ? CPF_OMITTED : CNPJ_OMITTED}`,
    )
    .replace(CNPJ_FORMATTED_RE, CNPJ_OMITTED)
    .replace(CPF_FORMATTED_RE, CPF_OMITTED)
    .replace(BARE_DIGITS_RE, (match: string) =>
      match.length === 11 && isValidCpf(match) ? CPF_OMITTED : match.length === 14 && isValidCnpj(match) ? CNPJ_OMITTED : match,
    );
}

/** O texto traz CPF ou CNPJ (pela mesma regra de `redactPersonalIds`)? */
export function containsPersonalId(text: string | null | undefined): boolean {
  return !!text && redactPersonalIds(text) !== text;
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
