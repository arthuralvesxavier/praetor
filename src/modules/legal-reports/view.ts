import type { LegalReportStatus, LegalReportType, ReportItemOrigin, Role } from "@/domain/enums";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  GAP_MARKER,
  itemDisplayText,
  type LegalReportParameters,
  type LegalReportScope,
  type RecordSource,
  type ReportItemData,
} from "@/domain/legal-reports";

/**
 * Visão de um relatório gravado (client-safe, pura): numeração dos itens,
 * separação entre itens afirmados e pendências, e fontes. É a mesma para a
 * tela e para o PDF, para que os dois mostrem exatamente o mesmo conteúdo.
 */

export type StoredReport = {
  id: string;
  type: LegalReportType;
  reference: string;
  version: number;
  title: string;
  isSample: boolean;
  status: LegalReportStatus;
  scope: LegalReportScope;
  processId: string | null;
  baseDate: string;
  parameters: LegalReportParameters;
  supersedesId: string | null;
  generatedAt: Date;
  generatedById: string | null;
  approvedById: string | null;
  approvedAt: Date | null;
  pdfSha256: string | null;
  pdfSizeBytes: number | null;
};

export type StoredItem = {
  id: string;
  section: string;
  position: number;
  content: string;
  origin: ReportItemOrigin;
  documentId: string | null;
  documentVersionId: string | null;
  page: number | null;
  excerpt: string | null;
  recordSource: RecordSource | null;
  derivedFrom: string[] | null;
  confidence: number | null;
  simulated: boolean;
  pendingReason: string | null;
  data: ReportItemData | null;
};

export type StoredSource = {
  id: string;
  itemId: string | null;
  reference: string;
  source: string;
  url: string | null;
  documentId: string | null;
  page: number | null;
  sensitive: boolean;
  checkedAt: Date;
  confirmed: boolean;
  notConfirmedReason: string | null;
};

export type ItemView = StoredItem & {
  number: string;
  displayText: string;
  sectionTitle: string;
  derivedFromNumbers: string[];
  source: StoredSource | null;
};

export type SectionView = { key: string; title: string; number: string; items: ItemView[] };

export type ReportView = StoredReport & {
  generatedByName: string | null;
  approvedByName: string | null;
  approvedByRole: Role | null;
  supersededById: string | null;
  sections: SectionView[];
  pendingItems: ItemView[];
  sources: (StoredSource & { itemNumber: string | null })[];
};

/** Número da seção de metodologia (as seções de conteúdo começam em 2). */
export const METHODOLOGY_NUMBER = "1";

export function buildReportView(
  report: StoredReport,
  items: readonly StoredItem[],
  sources: readonly StoredSource[],
  people: {
    generatedByName: string | null;
    approvedByName: string | null;
    approvedByRole: Role | null;
    supersededById: string | null;
  },
): ReportView {
  const sectionOrder = report.parameters.sections ?? [];
  const sectionIndex = new Map(sectionOrder.map((s, i) => [s.key, i]));
  const sorted = [...items].sort(
    (a, b) =>
      (sectionIndex.get(a.section) ?? 999) - (sectionIndex.get(b.section) ?? 999) || a.position - b.position,
  );
  const sourceByItem = new Map<string, StoredSource>();
  for (const s of sources) if (s.itemId) sourceByItem.set(s.itemId, s);

  const numbers = new Map<string, string>();
  const sectionNumber = (key: string) => String((sectionIndex.get(key) ?? 0) + 2);
  const counters = new Map<string, number>();
  let pendingCounter = 0;
  for (const item of sorted) {
    if (item.pendingReason) {
      pendingCounter += 1;
      numbers.set(item.id, `P${pendingCounter}`);
    } else {
      const n = (counters.get(item.section) ?? 0) + 1;
      counters.set(item.section, n);
      numbers.set(item.id, `${sectionNumber(item.section)}.${n}`);
    }
  }
  const titleOf = new Map(sectionOrder.map((s) => [s.key, s.title]));
  const toView = (item: StoredItem): ItemView => ({
    ...item,
    number: numbers.get(item.id) ?? "",
    displayText: itemDisplayText(item),
    sectionTitle: titleOf.get(item.section) ?? item.section,
    derivedFromNumbers: (item.derivedFrom ?? []).map((id) => numbers.get(id) ?? "?"),
    source: sourceByItem.get(item.id) ?? null,
  });

  const sections: SectionView[] = sectionOrder.map((s) => ({
    key: s.key,
    title: s.title,
    number: sectionNumber(s.key),
    items: sorted.filter((i) => i.section === s.key && !i.pendingReason).map(toView),
  }));
  const pendingItems = sorted.filter((i) => i.pendingReason).map(toView);
  const orderedSources = [...sources]
    .sort((a, b) => referenceOrder(a.reference) - referenceOrder(b.reference))
    .map((s) => ({ ...s, itemNumber: s.itemId ? (numbers.get(s.itemId) ?? null) : null }));

  return { ...report, ...people, sections, pendingItems, sources: orderedSources };
}

function referenceOrder(reference: string): number {
  const n = Number(/\d+/.exec(reference)?.[0] ?? "0");
  return (reference.startsWith("C") ? 100_000 : 0) + n;
}

/** "dd/mm/aaaa às hh:mm" (fuso da aplicação). */
export function dateTimeLabel(value: Date | null): string {
  if (!value) return "Não informado";
  return formatDateTime(value, "Não informado").replace(" ", " às ");
}

/** Data da fonte de cadastro ou análise, conforme a que ela se refere (registro, mais recente, consulta). */
export function recordDateNote(source: Pick<RecordSource, "recordedAt" | "dateBasis">): string {
  // Relatórios gravados antes da exigência da data: dizer só o que se sabe (o gerador não a informou).
  if (!source.recordedAt) return ", data do registro não informada pelo gerador";
  // Data (YYYY-MM-DD) como data de calendário; data e hora no fuso da aplicação.
  const day = formatDate(source.recordedAt, "data não informada");
  switch (source.dateBasis) {
    case "latest":
      return `, registro mais recente de ${day}`;
    case "query":
      return `, consulta de ${day} sem registros encontrados`;
    default:
      return `, registro de ${day}`;
  }
}

/** Notas de um item (fonte, data do registro, base da inferência, confiança, simulação): iguais na tela e no PDF. */
export function itemNotes(item: ItemView): string[] {
  const notes: string[] = [];
  if (item.origin === "documented") {
    if (item.source) notes.push(`Fonte ${item.source.reference}: ${item.source.source}.`);
    if (item.source?.sensitive) notes.push("Documento sensível: apenas referenciado, sem transcrição.");
    if (item.source?.confirmed) notes.push(`Trecho conferido na página em ${dateTimeLabel(item.source.checkedAt)}.`);
  } else if ((item.origin === "record" || item.origin === "analysis") && item.recordSource) {
    notes.push(`${item.recordSource.label}${recordDateNote(item.recordSource)}.`);
  } else if (item.origin === "inference" && item.derivedFromNumbers.length) {
    const list = item.derivedFromNumbers.join(", ");
    notes.push(item.derivedFromNumbers.length > 1 ? `Derivado dos itens ${list}.` : `Derivado do item ${list}.`);
  }
  if (item.confidence !== null) notes.push(`Confiança: ${item.confidence} de 100.`);
  if (item.simulated) notes.push("Conteúdo simulado (demonstração): não é fato do processo.");
  return notes;
}

/** Nota padrão sobre as regras de origem (vale para todo relatório). */
export function standardMethodology(view: Pick<ReportView, "parameters">): string[] {
  const t = view.parameters.confidenceThreshold;
  return [
    "Cada afirmação deste relatório traz um selo de origem: Documentado (trecho literal de documento, com página, conferido automaticamente no texto da página), Cadastro (dado do sistema, com tabela, campo e data do registro), Inferência (conclusão calculada a partir de outros itens, indicados na nota), Análise (análise registrada, com autor e data) ou Lacuna.",
    `Um dado não localizado aparece literalmente como ${GAP_MARKER}: nunca é tratado como zero nem deixado em branco. Itens com confiança abaixo de ${t} (limite definido nas configurações) não são afirmados e aparecem em "Pendências do relatório". Fontes que a conferência automática não confirmou aparecem em "Não confirmado" e nunca servem de base para afirmações.`,
    "Valor da causa e valor apurado são grandezas diferentes e nunca são somados entre si. Valores sem data-base não são atualizados; nenhum valor atualizado é gravado.",
  ];
}
