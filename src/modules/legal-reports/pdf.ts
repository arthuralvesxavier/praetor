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
import {
  dateTimeLabel,
  gapEntries,
  itemNotes,
  preparedByLabel,
  reportLayout,
  reportOutline,
  reviewedByLabel,
  sectionBlocks,
  standardMethodology,
  type ItemView,
  type ReportView,
  type SectionBlock,
  type SectionView,
} from "./view";

export const CONFIDENTIAL_STRIPE = "CONFIDENCIAL · USO INTERNO";
export const PENDING_WATERMARK = "PENDENTE DE REVISÃO";

/** Frase da regra das fontes não confirmadas (auditoria de fontes). */
export const UNCONFIRMED_RULE =
  "Fontes que a conferência automática não confirmou nunca são usadas como base de afirmação: os itens que dependiam delas não são afirmados e aparecem em Pendências do relatório.";

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
    // Uma linha de tabela fora da tabela (ex.: nas pendências) aparece pelo texto completo.
    text: item.displayText,
    quote: item.origin === "documented" && !item.source?.sensitive ? item.excerpt : null,
    notes,
  };
}

/** Linhas consecutivas do mesmo grupo: uma tabela com o selo de origem e o número de cada item. */
function rowsBlock(block: Extract<SectionBlock, { kind: "rows" }>): PdfBlock {
  const simulated = block.items.some((i) => i.simulated);
  const notes = [
    "Cada linha é um item do relatório, com a própria origem (selo). Os documentos citados estão na auditoria de fontes, pelo número do item.",
    simulated ? "Linhas marcadas como Simulação vêm da análise preliminar simulada e não são fatos do processo." : null,
  ].filter(Boolean);
  return {
    type: "table",
    caption: block.caption ?? undefined,
    columns: [
      { header: "Origem", weight: 1.5 },
      { header: "Item", weight: 0.55 },
      ...block.columns.map((c) => ({ header: c.header, weight: c.weight, align: c.align })),
    ],
    rows: block.items.map((item) => {
      const cells = item.data?.kind === "row" ? item.data.cells : [];
      return ["", item.number, ...block.columns.map((c, i) => cellDisplayText(cells[i] ?? null, c))];
    }),
    rowSeals: block.items.map((i) => i.origin),
    sealColumn: 0,
    note: notes.join(" "),
  };
}

function sectionContent(section: SectionView): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  if (section.items.length === 0) {
    blocks.push({ type: "paragraph", style: "small", text: "Nenhum item afirmado nesta seção (ver Pendências do relatório)." });
  }
  for (const b of sectionBlocks(section.items)) blocks.push(b.kind === "rows" ? rowsBlock(b) : itemBlock(b.item));
  if (section.note) blocks.push({ type: "callout", tone: "info", lines: [section.note] });
  return blocks;
}

function isApproved(view: ReportView): boolean {
  return view.status === "approved" || (view.status === "superseded" && !!view.approvedAt);
}

function approvalCallout(view: ReportView): PdfBlock {
  const rule = APPROVER_RULES[view.type];
  if (isApproved(view)) {
    return {
      type: "callout",
      tone: "stamp",
      title: "Aprovado",
      lines: [
        `Por: ${view.approvedByName ?? "Pessoa identificada"}${view.approvedByRole ? ` (${ROLE_LABELS[view.approvedByRole]})` : ""}`,
        `Em: ${dateTimeLabel(view.approvedAt)}`,
        `Versão: ${view.version} · Referência ${view.reference}`,
      ],
    };
  }
  return {
    type: "callout",
    tone: "warning",
    title: "Pendente de revisão",
    lines: [`Não utilizar como posição oficial antes da aprovação (${rule.description}).`],
  };
}

function sampleCallout(): PdfBlock {
  return {
    type: "callout",
    tone: "info",
    title: "Documento de teste do motor",
    lines: [
      "Gerado para conferir o layout e as regras de origem com dados de um processo. Não é um relatório jurídico e não deve ser usado como posição sobre o processo.",
    ],
  };
}

function pendingBlocks(view: ReportView, number: string, opts: { listGaps: boolean }): PdfBlock[] {
  const blocks: PdfBlock[] = [{ type: "heading", number, text: "Pendências do relatório" }];
  const gaps = opts.listGaps ? gapEntries(view) : [];
  if (view.pendingItems.length === 0 && gaps.length === 0) {
    blocks.push({ type: "paragraph", style: "small", text: "Nenhuma pendência: todos os itens foram afirmados com fonte confirmada e confiança suficiente." });
    return blocks;
  }
  if (view.pendingItems.length === 0) {
    blocks.push({
      type: "paragraph",
      style: "small",
      text: "Nenhum item deixou de ser afirmado: todas as fontes citadas foram confirmadas e nenhum item ficou abaixo do limite de confiança.",
    });
  } else {
    blocks.push({
      type: "paragraph",
      text: "Itens que NÃO são afirmados por este relatório: dependem de conferência humana antes de qualquer uso.",
    });
    for (const item of view.pendingItems) blocks.push(itemBlock(item, { pending: true }));
  }
  if (gaps.length > 0) {
    blocks.push({ type: "heading", level: 2, text: "Dados não localizados" });
    blocks.push({
      type: "table",
      columns: [
        { header: "Item", weight: 0.7 },
        { header: "Seção", weight: 1.9 },
        { header: "Dado", weight: 5 },
      ],
      rows: gaps.map((g) => [g.number, g.sectionTitle, g.text]),
      note: "Cada dado não localizado aparece aqui uma vez, com o item em que está marcado (no texto ou numa célula da tabela). Lacunas nunca são preenchidas por presunção: precisam ser obtidas e registradas na base.",
    });
  }
  return blocks;
}

function sourcesTable(view: ReportView): PdfBlock {
  const confirmed = view.sources.filter((s) => s.confirmed);
  return {
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
  };
}

/** Relatórios da disposição padrão (documento de teste do motor e tipos sem disposição própria). */
function buildStandardBlocks(view: ReportView): PdfBlock[] {
  const code = LEGAL_REPORT_TYPE_CODES[view.type];
  const baseDate = formatDate(view.baseDate, view.baseDate);
  const rule = APPROVER_RULES[view.type];
  const approved = isApproved(view);
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
  if (view.isSample) blocks.push(sampleCallout());
  blocks.push(approvalCallout(view), { type: "pageBreak" });

  const unconfirmed = view.sources.filter((s) => !s.confirmed);
  for (const entry of reportOutline(view)) {
    switch (entry.kind) {
      case "methodology":
        blocks.push({ type: "heading", number: entry.number, text: "Nota metodológica" });
        for (const p of [...view.parameters.methodology, ...standardMethodology(view)]) blocks.push({ type: "paragraph", text: p });
        break;
      case "section":
        blocks.push({ type: "heading", number: entry.number, text: entry.section.title }, ...sectionContent(entry.section));
        break;
      case "pending":
        blocks.push(...pendingBlocks(view, entry.number, { listGaps: false }));
        break;
      case "sources":
        blocks.push({ type: "heading", number: entry.number, text: "Fontes consultadas" }, sourcesTable(view));
        break;
      case "unconfirmed":
        blocks.push({ type: "heading", number: entry.number, text: "Não confirmado" });
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
        break;
    }
  }
  return blocks;
}

/**
 * R1 (Relatório de Processo): capa de identificação (1) com os dados do
 * relatório e os itens do processo, nota metodológica (2), seções 3 a 8,
 * auditoria de fontes (verificado e não confirmado) e pendências por último.
 */
function buildProcessReportBlocks(view: ReportView): PdfBlock[] {
  const code = LEGAL_REPORT_TYPE_CODES[view.type];
  const approved = isApproved(view);
  const blocks: PdfBlock[] = [
    { type: "spacer", height: 14 },
    { type: "paragraph", style: "kicker", text: `Relatório jurídico · ${code}${view.isSample ? " · Documento de teste do motor" : ""}` },
    { type: "paragraph", style: "title", text: view.title, spaceBefore: 6 },
  ];
  if (view.parameters.subtitle) blocks.push({ type: "paragraph", style: "subtitle", text: view.parameters.subtitle });
  blocks.push({ type: "rule", width: 48, thickness: 1.6, color: "gold", spaceBefore: 12, spaceAfter: 2 });

  const outline = reportOutline(view);
  const unconfirmed = view.sources.filter((s) => !s.confirmed);
  const confirmed = view.sources.filter((s) => s.confirmed);
  for (const entry of outline) {
    switch (entry.kind) {
      case "section": {
        blocks.push({ type: "heading", number: entry.number, text: entry.section.title });
        if (entry.number === "1") {
          // Dados do próprio relatório (não são afirmações sobre o processo: sem selo).
          blocks.push(
            {
              type: "keyValues",
              pairs: [
                { label: "Referência", value: `${view.reference} · versão ${view.version}` },
                { label: "Data-base", value: formatDate(view.baseDate, view.baseDate) },
                { label: "Situação", value: approved ? "Aprovado" : LEGAL_REPORT_STATUS_LABELS[view.status] },
                { label: "Gerado em", value: dateTimeLabel(view.generatedAt) },
                { label: "Elaborado por", value: preparedByLabel(view) },
                { label: "Revisado por", value: reviewedByLabel(view) },
              ],
            },
            {
              type: "keyValues",
              columns: 1,
              pairs: [
                { label: "Finalidade", value: view.parameters.purpose ?? "Relatório interno de acompanhamento do processo" },
                { label: "Base legal do tratamento de dados", value: view.parameters.legalBasisText },
              ],
            },
            approvalCallout(view),
          );
          if (view.isSample) blocks.push(sampleCallout());
        }
        blocks.push(...sectionContent(entry.section));
        break;
      }
      case "methodology":
        blocks.push({ type: "heading", number: entry.number, text: "Nota metodológica" });
        for (const p of [...view.parameters.methodology, ...standardMethodology(view)]) blocks.push({ type: "paragraph", text: p });
        break;
      case "sources":
        blocks.push(
          { type: "heading", number: entry.number, text: "Auditoria de fontes" },
          {
            type: "paragraph",
            text: `Toda fonte documental citada foi conferida automaticamente na geração: documento visível a quem gerou, versão com o mesmo hash lido, página existente e trecho literal encontrado no texto da página. Dados de cadastro foram lidos diretamente da base. ${UNCONFIRMED_RULE}`,
          },
          { type: "heading", level: 2, text: "Verificado" },
          {
            type: "table",
            columns: [
              { header: "Referência", weight: 0.85 },
              { header: "Fonte", weight: 4.6 },
              { header: "Itens", weight: 0.7 },
              { header: "Data da conferência", weight: 1.45 },
            ],
            rows: confirmed.map((s) => [
              s.reference,
              `${s.source}${s.sensitive ? " (documento sensível: apenas referenciado, sem transcrição)" : ""}`,
              s.itemNumber ?? "Vários",
              formatDateTime(s.checkedAt, "Não informado"),
            ]),
            emptyText: "Nenhuma fonte confirmada.",
          },
          { type: "heading", level: 2, text: "Não confirmado" },
        );
        if (unconfirmed.length === 0) {
          blocks.push({ type: "paragraph", style: "small", text: "Nenhuma fonte deixou de ser confirmada pela conferência automática." });
        } else {
          blocks.push({
            type: "table",
            columns: [
              { header: "Referência", weight: 3.2 },
              { header: "Motivo", weight: 3.6 },
              { header: "Item", weight: 0.6 },
            ],
            rows: unconfirmed.map((s) => [`${s.reference} · ${s.source}`, s.notConfirmedReason ?? "Não confirmada", s.itemNumber ?? "Vários"]),
            note: UNCONFIRMED_RULE,
          });
        }
        break;
      case "pending":
        blocks.push(...pendingBlocks(view, entry.number, { listGaps: true }));
        break;
      case "unconfirmed":
        break;
    }
  }
  return blocks;
}

/** Monta o documento PDF de um relatório (mesma visão da tela). */
export function buildLegalReportPdfSpec(view: ReportView): PdfDocumentSpec {
  const approved = isApproved(view);
  const code = LEGAL_REPORT_TYPE_CODES[view.type];
  const baseDate = formatDate(view.baseDate, view.baseDate);
  const blocks = reportLayout(view) === "process_report" ? buildProcessReportBlocks(view) : buildStandardBlocks(view);
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
