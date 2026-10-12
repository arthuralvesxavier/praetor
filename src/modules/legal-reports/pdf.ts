import { createHash } from "node:crypto";
import {
  LEGAL_REPORT_STATUS_LABELS,
  LEGAL_REPORT_TYPE_CODES,
  LEGAL_REPORT_TYPE_LABELS,
  REPORT_ITEM_ORIGIN_DESCRIPTIONS,
  REPORT_ITEM_ORIGIN_LABELS,
  ROLE_LABELS,
} from "@/domain/enums";
import { cellDisplayText } from "@/domain/legal-reports";
import { formatDate, formatDateTime } from "@/lib/format";
import { renderPdf, type PdfBlock, type PdfDocumentSpec } from "@/server/pdf";
import { APPROVER_RULES } from "./approvers";
import { dateTimeLabel, itemNotes, METHODOLOGY_NUMBER, standardMethodology, type ItemView, type ReportView } from "./view";

export const CONFIDENTIAL_STRIPE = "CONFIDENCIAL · USO INTERNO";
export const PENDING_WATERMARK = "PENDENTE DE REVISÃO";

function itemBlock(item: ItemView, opts: { pending?: boolean } = {}): PdfBlock {
  const notes = itemNotes(item);
  if (opts.pending) {
    notes.unshift(`Seção de origem: ${item.sectionTitle}.`);
    if (item.pendingReason) notes.unshift(`Motivo: ${item.pendingReason}`);
  }
  if (item.data?.kind === "table") {
    const data = item.data;
    const rowNotes = [data.note, ...notes].filter(Boolean).join(" ");
    return {
      type: "table",
      caption: `${item.number}  ${item.content}`,
      seal: item.origin,
      columns: data.columns.map((c) => ({ header: c.header, weight: c.weight, align: c.align })),
      rows: data.rows.map((r) => r.map((cell, i) => cellDisplayText(cell, data.columns[i]))),
      totals: data.totals ? data.totals.map((cell, i) => (i === 0 ? (cell ?? "Totais") : (cell ?? ""))) : null,
      note: rowNotes || null,
    };
  }
  return {
    type: "item",
    seal: item.origin,
    number: item.number,
    text: item.displayText,
    quote: item.origin === "documented" && !item.source?.sensitive ? item.excerpt : null,
    notes,
  };
}

/** Monta o documento PDF de um relatório (mesma visão da tela). */
export function buildLegalReportPdfSpec(view: ReportView): PdfDocumentSpec {
  const approved = view.status === "approved" || (view.status === "superseded" && !!view.approvedAt);
  const code = LEGAL_REPORT_TYPE_CODES[view.type];
  const baseDate = formatDate(view.baseDate, view.baseDate);
  const rule = APPROVER_RULES[view.type];
  const blocks: PdfBlock[] = [];

  // Capa.
  blocks.push(
    { type: "spacer", height: 30 },
    {
      type: "paragraph",
      style: "kicker",
      text: `Relatório jurídico · ${code}${view.isSample ? " · Documento de teste do motor" : ""}`,
    },
    { type: "paragraph", style: "title", text: view.title, spaceBefore: 8 },
  );
  if (view.parameters.subtitle) blocks.push({ type: "paragraph", style: "subtitle", text: view.parameters.subtitle });
  blocks.push(
    { type: "rule", width: 48, thickness: 1.6, color: "gold", spaceBefore: 16, spaceAfter: 4 },
    {
      type: "keyValues",
      pairs: [
        { label: "Referência", value: view.reference },
        { label: "Versão", value: String(view.version) },
        { label: "Tipo", value: LEGAL_REPORT_TYPE_LABELS[view.type] },
        { label: "Situação", value: approved ? "Aprovado" : LEGAL_REPORT_STATUS_LABELS[view.status] },
        { label: "Escopo", value: view.parameters.scopeLabel },
        { label: "Data-base", value: baseDate },
        { label: "Gerado em", value: dateTimeLabel(view.generatedAt) },
        { label: "Gerado por", value: view.generatedByName ?? "Sistema (geração automática)" },
        { label: "Aprovação", value: approved ? `${view.approvedByName ?? "Pessoa identificada"} em ${dateTimeLabel(view.approvedAt)}` : `Pendente: ${rule.description}` },
        { label: "Limite de confiança", value: `${view.parameters.confidenceThreshold} de 100` },
        { label: "Base legal do tratamento de dados", value: view.parameters.legalBasisText },
      ],
    },
  );
  if (view.isSample) {
    blocks.push({
      type: "callout",
      tone: "info",
      title: "Documento de teste do motor",
      lines: [
        "Gerado para conferir o layout e as regras de origem com dados de um processo. Não é um relatório jurídico e não deve ser usado como posição sobre o processo.",
      ],
    });
  }
  if (approved) {
    blocks.push({
      type: "callout",
      tone: "stamp",
      title: "Aprovado",
      lines: [
        `Por: ${view.approvedByName ?? "Pessoa identificada"}${view.approvedByRole ? ` (${ROLE_LABELS[view.approvedByRole]})` : ""}`,
        `Em: ${dateTimeLabel(view.approvedAt)}`,
        `Versão: ${view.version} · Referência ${view.reference}`,
      ],
    });
  } else {
    blocks.push({
      type: "callout",
      tone: "warning",
      title: "Pendente de revisão",
      lines: [`Não utilizar como posição oficial antes da aprovação (${rule.description}).`],
    });
  }
  blocks.push({ type: "pageBreak" });

  // 1. Nota metodológica.
  blocks.push({ type: "heading", number: METHODOLOGY_NUMBER, text: "Nota metodológica" });
  for (const p of [...view.parameters.methodology, ...standardMethodology(view)]) blocks.push({ type: "paragraph", text: p });

  // Seções de conteúdo.
  for (const section of view.sections) {
    blocks.push({ type: "heading", number: section.number, text: section.title });
    if (section.items.length === 0) {
      blocks.push({ type: "paragraph", style: "small", text: "Nenhum item afirmado nesta seção (ver Pendências do relatório)." });
    }
    for (const item of section.items) blocks.push(itemBlock(item));
  }

  // Pendências.
  const n = view.sections.length + 2;
  blocks.push({ type: "heading", number: String(n), text: "Pendências do relatório" });
  if (view.pendingItems.length === 0) {
    blocks.push({ type: "paragraph", style: "small", text: "Nenhuma pendência: todos os itens foram afirmados com fonte confirmada e confiança suficiente." });
  } else {
    blocks.push({
      type: "paragraph",
      text: "Itens que NÃO são afirmados por este relatório: dependem de conferência humana antes de qualquer uso.",
    });
    for (const item of view.pendingItems) blocks.push(itemBlock(item, { pending: true }));
  }

  // Fontes.
  const confirmed = view.sources.filter((s) => s.confirmed);
  const unconfirmed = view.sources.filter((s) => !s.confirmed);
  blocks.push({ type: "heading", number: String(n + 1), text: "Fontes consultadas" });
  blocks.push({
    type: "table",
    columns: [
      { header: "Ref.", weight: 0.55 },
      { header: "Fonte e local no sistema", weight: 5.2 },
      { header: "Item", weight: 0.6 },
      { header: "Conferida em", weight: 1.35 },
    ],
    rows: confirmed.map((s) => [
      s.reference,
      `${s.source}${s.sensitive ? " (documento sensível, só referenciado)" : ""}${s.url ? `\n${s.url}` : ""}`,
      s.itemNumber ?? "Vários",
      formatDateTime(s.checkedAt, "Não informado"),
    ]),
    emptyText: "Nenhuma fonte confirmada.",
  });

  blocks.push({ type: "heading", number: String(n + 2), text: "Não confirmado" });
  if (unconfirmed.length === 0) {
    blocks.push({ type: "paragraph", style: "small", text: "Todas as fontes documentais citadas foram confirmadas pela conferência automática." });
  } else {
    blocks.push({
      type: "paragraph",
      text: "Fontes que a conferência automática não confirmou. Nunca são usadas como base de afirmação; os itens que dependiam delas estão em Pendências do relatório.",
    });
    blocks.push({
      type: "table",
      columns: [
        { header: "Ref.", weight: 0.55 },
        { header: "Fonte citada", weight: 2.8 },
        { header: "Motivo", weight: 3 },
        { header: "Item", weight: 0.6 },
      ],
      rows: unconfirmed.map((s) => [s.reference, s.source, s.notConfirmedReason ?? "Não confirmada", s.itemNumber ?? "Vários"]),
    });
  }

  return {
    info: {
      title: `${view.reference} v${view.version} · ${view.title}`,
      subject: LEGAL_REPORT_TYPE_LABELS[view.type],
      keywords: [view.reference, code, "Praetor"],
      createdAt: approved && view.approvedAt ? view.approvedAt : view.generatedAt,
    },
    headerStripe: CONFIDENTIAL_STRIPE,
    footer: {
      reference: `${view.reference} · versão ${view.version}`,
      baseDateLabel: `Data-base ${baseDate}`,
      statement: `O conteúdo reflete o estado da base em ${baseDate}.`,
    },
    watermark: approved ? null : PENDING_WATERMARK,
    blocks,
    sealLegend: { title: "Legenda das origens", labels: REPORT_ITEM_ORIGIN_LABELS, descriptions: REPORT_ITEM_ORIGIN_DESCRIPTIONS },
  };
}

export type RenderedLegalReport = { bytes: Uint8Array; sha256: string; pageCount: number };

export async function renderLegalReportPdf(view: ReportView): Promise<RenderedLegalReport> {
  const { bytes, pageCount } = await renderPdf(buildLegalReportPdfSpec(view));
  return { bytes, pageCount, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Nome do arquivo baixado (ex.: "R1-2026-0007-v1.pdf"). */
export function legalReportFileName(view: Pick<ReportView, "reference" | "version">): string {
  return `${view.reference}-v${view.version}.pdf`;
}
