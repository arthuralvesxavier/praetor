/**
 * Renderers of the simulated e-mails (pure, no server imports).
 *
 * Every template is first described as a small content model (heading,
 * paragraphs, facts, lists, notices, call-to-action) and then rendered twice —
 * plain text and table-based HTML with inline styles — so both versions always
 * carry the same information. Rules:
 *   - the subject always starts with "[Simulação]";
 *   - both bodies start with the banner "SIMULAÇÃO: este e-mail não foi enviado";
 *   - every interpolated value is HTML-escaped; links are absolute http(s) URLs;
 *   - demo-mode content says it is demonstrative (CASE_BRIEF_DEMO_NOTICE).
 */
import { CASE_BRIEF_DEMO_NOTICE, CASE_BRIEF_DISCLAIMER } from "@/domain/case-brief";
import { normalizeCnj } from "@/domain/cnj";
import type { EmailTemplate } from "@/domain/enums";
import { formatDate, formatDateTime, formatNumber, todayISO } from "@/lib/format";
import type { EmailTemplateDataMap } from "./templates";

export const SUBJECT_PREFIX = "[Simulação]";
export const SIMULATION_BANNER = "SIMULAÇÃO: este e-mail não foi enviado";
export const SIMULATION_FOOTER =
  "Mensagem gerada automaticamente pelo Praetor em modo de simulação: nada foi entregue a servidor de e-mail algum. " +
  "O conteúdo fica disponível apenas na Central de e-mails do sistema.";

const BRAND_NAVY = "#0B1A2C";
const BRAND_GOLD = "#D4B062";
const MAX_SUBJECT = 200;

export type RenderContext = {
  /** Display name of the recipient (greeting). */
  recipientName: string;
  /** Absolute URL of the main call-to-action (APP_URL + linkPath). */
  linkUrl: string;
  /** Absolute base URL of the application (for digest item links). */
  appUrl: string;
  /** Reference instant (digest date). Defaults to now. */
  now?: Date;
};

export type RenderedEmail = { subject: string; text: string; html: string };

// ---------------------------------------------------------------------------
// Content model
// ---------------------------------------------------------------------------

type Fact = { label: string; value: string };
type NoticeTone = "demo" | "info" | "warning";
type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "facts"; rows: Fact[] }
  | { kind: "list"; title: string; items: string[]; empty: string }
  | { kind: "notice"; tone: NoticeTone; title: string; text: string }
  | { kind: "counters"; title: string; items: { label: string; count: number; url: string }[] };

type EmailContent = {
  subject: string;
  /** Hidden preview line shown by e-mail clients. */
  preheader: string;
  heading: string;
  blocks: Block[];
  cta: { label: string; url: string };
};

// ---------------------------------------------------------------------------
// Escaping & sanitizing
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Removes control characters. Line breaks are kept when `multiline`; otherwise
 * they (and tabs) become spaces, so a value can never break a header or a line.
 */
export function clean(value: string, multiline = false): string {
  const normalized = value.replace(/\r\n?/g, "\n");
  let out = "";
  for (const ch of normalized) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a) out += multiline ? "\n" : " ";
    else if (code === 0x09) out += " ";
    else if (code < 0x20 || code === 0x7f) continue;
    else out += ch;
  }
  return multiline ? out.trim() : out.replace(/ {2,}/g, " ").trim();
}

/** Single-line subject with the mandatory prefix (no header injection, length-capped). */
export function buildSubject(title: string): string {
  const body = clean(title).replace(/\s{2,}/g, " ");
  const full = `${SUBJECT_PREFIX} ${body}`;
  return full.length > MAX_SUBJECT ? `${full.slice(0, MAX_SUBJECT - 1)}…` : full;
}

/** Only absolute http(s) URLs are allowed in links; anything else becomes "#". */
export function safeUrl(url: string): string {
  return /^https?:\/\/[^\s"'<>`]+$/i.test(url) ? url : "#";
}

/** Absolute URL for an app path ("/processos/…"), given the app base URL. */
export function absoluteUrl(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** "Proc. 0000000-00.0000.0.00.0000" — formats a 20-digit CNJ, otherwise keeps the informed number. */
function processRef(number: string): string {
  return `Proc. ${normalizeCnj(number) ?? clean(number)}`;
}

function plural(n: number, singular: string, pluralForm: string): string {
  return `${formatNumber(n)} ${n === 1 ? singular : pluralForm}`;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

type Builder<T extends EmailTemplate> = (data: EmailTemplateDataMap[T], ctx: RenderContext) => EmailContent;

const BUILDERS: { [K in EmailTemplate]: Builder<K> } = {
  case_brief_ready: (d, ctx) => {
    const ref = processRef(d.processNumber);
    const blocks: Block[] = [];
    if (d.isDemo) {
      blocks.push({ kind: "notice", tone: "demo", title: "Atenção", text: CASE_BRIEF_DEMO_NOTICE });
    }
    const facts: Block = {
      kind: "facts",
      rows: [
        { label: "Processo", value: normalizeCnj(d.processNumber) ?? d.processNumber },
        { label: "Título", value: d.processTitle },
        { label: "Partes", value: d.parties },
        { label: "Órgão julgador", value: d.court ?? "Não informado" },
      ],
    };
    if (d.digestOmitted) {
      return {
        subject: buildSubject(`Análise preliminar disponível: ${ref}`),
        preheader: `${d.isDemo ? "Análise demonstrativa · " : ""}Análise preliminar v${d.briefVersion} gerada (resumo não incluído).`,
        heading: "Análise preliminar disponível",
        blocks: [
          ...blocks,
          {
            kind: "paragraph",
            text:
              `Olá, ${ctx.recipientName}. A análise preliminar (versão ${d.briefVersion}) do processo abaixo foi gerada. ` +
              "Nada foi alterado no cadastro do processo.",
          },
          facts,
          {
            kind: "notice",
            tone: "warning",
            title: "Resumo não incluído",
            text:
              "O resumo da análise não foi incluído neste e-mail porque ela usa documentos aos quais o seu perfil não tem acesso. " +
              "Peça à gestão jurídica para revisar o acesso aos documentos do processo antes da revisão.",
          },
          { kind: "notice", tone: "info", title: "Importante", text: CASE_BRIEF_DISCLAIMER },
        ],
        cta: { label: "Abrir o processo", url: ctx.linkUrl },
      };
    }
    blocks.push(
      {
        kind: "paragraph",
        text:
          `Olá, ${ctx.recipientName}. A análise preliminar (versão ${d.briefVersion}) do processo abaixo foi gerada ` +
          "e aguarda a sua revisão. Nada foi alterado no cadastro do processo.",
      },
      facts,
      { kind: "paragraph", text: `Síntese: ${d.headline}` },
      { kind: "list", title: "Pontos de atenção", items: d.urgencies, empty: "Nenhum ponto de atenção indicado." },
      {
        kind: "list",
        title: "Possíveis prazos a conferir",
        items: d.possibleDeadlines.map(
          (p) => `${p.description}: ${p.date ? formatDate(p.date) : "data não identificada"}`,
        ),
        empty: "Nenhum possível prazo indicado.",
      },
      {
        kind: "facts",
        rows: [
          { label: "Lacunas de informação", value: plural(d.gapsCount, "lacuna", "lacunas") },
          {
            label: "Documentos possivelmente faltantes",
            value: plural(d.missingDocumentsCount, "documento", "documentos"),
          },
        ],
      },
      { kind: "notice", tone: "info", title: "Importante", text: CASE_BRIEF_DISCLAIMER },
    );
    return {
      subject: buildSubject(`Análise preliminar disponível: ${ref}`),
      preheader: `${d.isDemo ? "Análise demonstrativa · " : ""}Análise preliminar v${d.briefVersion} aguardando revisão.`,
      heading: "Análise preliminar disponível para revisão",
      blocks,
      cta: { label: "Abrir análise preliminar", url: ctx.linkUrl },
    };
  },

  intake_assigned: (d, ctx) => ({
    subject: buildSubject(`Novo processo atribuído: ${processRef(d.processNumber)}`),
    preheader: "Um novo processo foi atribuído a você.",
    heading: "Novo processo atribuído a você",
    blocks: [
      {
        kind: "paragraph",
        text: `Olá, ${ctx.recipientName}. Você foi indicado como responsável pelo processo abaixo.`,
      },
      {
        kind: "facts",
        rows: [
          { label: "Processo", value: normalizeCnj(d.processNumber) ?? d.processNumber },
          { label: "Título", value: d.processTitle },
          { label: "Órgão julgador", value: d.court ?? "Não informado" },
          { label: "Recebido em", value: formatDateTime(d.receivedAt) },
          { label: "Critério de atribuição", value: d.assignmentReason },
        ],
      },
      {
        kind: "paragraph",
        text: "Confira os dados do processo e, se a atribuição não estiver correta, solicite a redistribuição.",
      },
    ],
    cta: { label: "Abrir processo", url: ctx.linkUrl },
  }),

  deadline_reminder: (d, ctx) => {
    const blocks: Block[] = [
      { kind: "paragraph", text: `Olá, ${ctx.recipientName}. Este é um lembrete do prazo abaixo.` },
      {
        kind: "facts",
        rows: [
          { label: "Prazo", value: d.title },
          { label: "Vencimento", value: formatDate(d.dueDate) },
          {
            label: "Processo",
            value: d.processNumber ? (normalizeCnj(d.processNumber) ?? d.processNumber) : "Sem processo vinculado",
          },
        ],
      },
    ];
    if (d.pendingValidation) {
      blocks.push({
        kind: "notice",
        tone: "warning",
        title: "Prazo aguardando validação",
        text:
          "Este prazo foi sugerido automaticamente e ainda aguarda validação humana: não é um prazo confirmado. " +
          "Confira nos autos antes de considerá-lo.",
      });
    }
    return {
      subject: buildSubject(`Lembrete de prazo: ${d.title} (${formatDate(d.dueDate)})`),
      preheader: `Vencimento em ${formatDate(d.dueDate)}.`,
      heading: d.pendingValidation ? "Lembrete de prazo (aguardando validação)" : "Lembrete de prazo",
      blocks,
      cta: { label: "Abrir prazo", url: ctx.linkUrl },
    };
  },

  hearing_reminder: (d, ctx) => ({
    subject: buildSubject(`Lembrete de audiência: ${processRef(d.processNumber)} em ${formatDateTime(d.scheduledAt)}`),
    preheader: `${d.kindLabel} em ${formatDateTime(d.scheduledAt)}.`,
    heading: "Lembrete de audiência",
    blocks: [
      { kind: "paragraph", text: `Olá, ${ctx.recipientName}. Há uma audiência designada no processo abaixo.` },
      {
        kind: "facts",
        rows: [
          { label: "Processo", value: normalizeCnj(d.processNumber) ?? d.processNumber },
          { label: "Título", value: d.processTitle },
          { label: "Tipo", value: d.kindLabel },
          { label: "Modalidade", value: d.modeLabel },
          { label: "Data e hora", value: `${formatDateTime(d.scheduledAt)} (horário de Brasília)` },
          { label: "Local", value: d.location ?? "Não informado" },
        ],
      },
      {
        kind: "paragraph",
        text: "Confira a pauta no sistema do tribunal: esta mensagem reflete apenas o cadastro feito no Praetor.",
      },
    ],
    cta: { label: "Abrir audiências do processo", url: ctx.linkUrl },
  }),

  daily_digest: (d, ctx) => {
    const day = formatDate(todayISO(ctx.now ?? new Date()));
    const total = d.items.reduce((sum, i) => sum + i.count, 0);
    return {
      subject: buildSubject(`Resumo diário de pendências de ${day}`),
      preheader: total > 0 ? `${plural(total, "pendência", "pendências")} no resumo de hoje.` : "Nenhuma pendência hoje.",
      heading: "Resumo diário de pendências",
      blocks: [
        {
          kind: "paragraph",
          text: `Olá, ${ctx.recipientName}. Estas são as contagens das pendências que você pode acessar no Praetor em ${day}.`,
        },
        {
          kind: "counters",
          title: "Pendências",
          items: d.items.map((i) => ({ label: i.label, count: i.count, url: absoluteUrl(ctx.appUrl, i.path) })),
        },
        {
          kind: "paragraph",
          text: "As contagens consideram apenas os registros visíveis para o seu perfil no momento da geração.",
        },
      ],
      cta: { label: "Abrir o painel", url: ctx.linkUrl },
    };
  },

  brief_approved: (d, ctx) => ({
    subject: buildSubject(`Análise preliminar aprovada: ${processRef(d.processNumber)}`),
    preheader: `Versão ${d.briefVersion} aprovada por ${d.approvedByName}.`,
    heading: "Análise preliminar aprovada",
    blocks: [
      {
        kind: "paragraph",
        text:
          `Olá, ${ctx.recipientName}. A análise preliminar (versão ${d.briefVersion}) do processo abaixo foi ` +
          `aprovada por ${d.approvedByName}.`,
      },
      {
        kind: "facts",
        rows: [
          { label: "Processo", value: normalizeCnj(d.processNumber) ?? d.processNumber },
          { label: "Título", value: d.processTitle },
          { label: "Aprovada por", value: d.approvedByName },
        ],
      },
      { kind: "notice", tone: "info", title: "Importante", text: CASE_BRIEF_DISCLAIMER },
    ],
    cta: { label: "Abrir análise preliminar", url: ctx.linkUrl },
  }),
};

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

const RULE = "=".repeat(60);

function renderText(c: EmailContent): string {
  const out: string[] = [RULE, SIMULATION_BANNER, RULE, "", "PRAETOR · Gestão jurídica corporativa", "", c.heading.toUpperCase(), ""];
  for (const b of c.blocks) {
    switch (b.kind) {
      case "paragraph":
        out.push(clean(b.text, true), "");
        break;
      case "facts":
        for (const r of b.rows) out.push(`${r.label}: ${clean(r.value)}`);
        out.push("");
        break;
      case "list":
        out.push(`${b.title}:`);
        if (b.items.length === 0) out.push(`  ${b.empty}`);
        for (const item of b.items) out.push(`  - ${clean(item)}`);
        out.push("");
        break;
      case "notice":
        out.push(`[${b.title.toUpperCase()}] ${clean(b.text, true)}`, "");
        break;
      case "counters":
        out.push(`${b.title}:`);
        if (b.items.length === 0) out.push("  Nenhuma contagem disponível para o seu perfil.");
        for (const i of b.items) out.push(`  - ${clean(i.label)}: ${formatNumber(i.count)} (${safeUrl(i.url)})`);
        out.push("");
        break;
    }
  }
  out.push(`${c.cta.label}: ${safeUrl(c.cta.url)}`, "", "--", SIMULATION_FOOTER);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// HTML (table-based, inline styles — what e-mail clients support)
// ---------------------------------------------------------------------------

const FONT = "Arial,Helvetica,sans-serif";

/** Escaped text with line breaks preserved. */
function htmlText(value: string): string {
  return escapeHtml(clean(value, true)).replace(/\n/g, "<br>");
}

const NOTICE_STYLES: Record<NoticeTone, { bg: string; border: string; color: string }> = {
  demo: { bg: "#fffbeb", border: "#d97706", color: "#78350f" },
  info: { bg: "#f1f5f9", border: "#94a3b8", color: "#334155" },
  warning: { bg: "#fff7ed", border: "#ea580c", color: "#7c2d12" },
};

function htmlBlock(b: Block): string {
  switch (b.kind) {
    case "paragraph":
      return `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:23px;color:#1e293b;">${htmlText(b.text)}</p>`;
    case "facts":
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border-collapse:collapse;">` +
        b.rows
          .map(
            (r) =>
              `<tr>` +
              `<td valign="top" style="padding:7px 12px 7px 0;width:38%;border-bottom:1px solid #e2e8f0;font-family:${FONT};font-size:13px;line-height:19px;color:#64748b;">${htmlText(r.label)}</td>` +
              `<td valign="top" style="padding:7px 0;border-bottom:1px solid #e2e8f0;font-family:${FONT};font-size:14px;line-height:20px;color:#0f172a;font-weight:bold;">${escapeHtml(clean(r.value))}</td>` +
              `</tr>`,
          )
          .join("") +
        `</table>`
      );
    case "list":
      return (
        `<p style="margin:0 0 6px;font-family:${FONT};font-size:13px;line-height:19px;font-weight:bold;text-transform:uppercase;letter-spacing:0.04em;color:${BRAND_NAVY};">${htmlText(b.title)}</p>` +
        (b.items.length === 0
          ? `<p style="margin:0 0 16px;font-family:${FONT};font-size:14px;line-height:21px;color:#64748b;">${htmlText(b.empty)}</p>`
          : `<ul style="margin:0 0 16px;padding:0 0 0 20px;font-family:${FONT};font-size:14px;line-height:21px;color:#1e293b;">` +
            b.items.map((i) => `<li style="margin:0 0 4px;">${escapeHtml(clean(i))}</li>`).join("") +
            `</ul>`)
      );
    case "notice": {
      const s = NOTICE_STYLES[b.tone];
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">` +
        `<tr><td style="padding:12px 14px;background-color:${s.bg};border-left:4px solid ${s.border};font-family:${FONT};font-size:13px;line-height:20px;color:${s.color};">` +
        `<strong style="display:block;margin:0 0 2px;">${htmlText(b.title)}</strong>${htmlText(b.text)}` +
        `</td></tr></table>`
      );
    }
    case "counters":
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border-collapse:collapse;border:1px solid #e2e8f0;">` +
        `<tr><th align="left" style="padding:8px 12px;background-color:#f8fafc;border-bottom:1px solid #e2e8f0;font-family:${FONT};font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:0.04em;">${htmlText(b.title)}</th>` +
        `<th align="right" style="padding:8px 12px;background-color:#f8fafc;border-bottom:1px solid #e2e8f0;font-family:${FONT};font-size:12px;color:#475569;text-transform:uppercase;letter-spacing:0.04em;">Quantidade</th></tr>` +
        (b.items.length === 0
          ? `<tr><td colspan="2" style="padding:10px 12px;font-family:${FONT};font-size:14px;color:#64748b;">Nenhuma contagem disponível para o seu perfil.</td></tr>`
          : b.items
              .map(
                (i) =>
                  `<tr>` +
                  `<td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-family:${FONT};font-size:14px;line-height:20px;">` +
                  `<a href="${escapeHtml(safeUrl(i.url))}" style="color:${BRAND_NAVY};text-decoration:underline;">${escapeHtml(clean(i.label))}</a></td>` +
                  `<td align="right" style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-family:${FONT};font-size:16px;font-weight:bold;color:${i.count > 0 ? BRAND_NAVY : "#94a3b8"};">${escapeHtml(formatNumber(i.count))}</td>` +
                  `</tr>`,
              )
              .join("")) +
        `</table>`
      );
  }
}

function renderHtml(c: EmailContent): string {
  const url = escapeHtml(safeUrl(c.cta.url));
  return [
    `<!doctype html>`,
    `<html lang="pt-BR">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="light">`,
    `<base target="_blank">`,
    `<title>${escapeHtml(c.subject)}</title>`,
    `</head>`,
    `<body style="margin:0;padding:0;background-color:#f1f3f6;">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(clean(c.preheader))}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f3f6;">`,
    `<tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;">`,
    // Simulation banner (always first).
    `<tr><td style="padding:10px 24px;background-color:#fef3c7;border-bottom:1px solid ${BRAND_GOLD};font-family:${FONT};font-size:12px;line-height:18px;font-weight:bold;letter-spacing:0.06em;color:#78350f;text-align:center;">${escapeHtml(SIMULATION_BANNER)}</td></tr>`,
    // Brand header.
    `<tr><td style="padding:20px 24px;background-color:${BRAND_NAVY};">`,
    `<span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:26px;font-weight:bold;letter-spacing:0.12em;color:#ffffff;">PRAETOR</span>`,
    `<span style="display:block;margin-top:4px;font-family:${FONT};font-size:12px;line-height:16px;color:${BRAND_GOLD};">Gestão jurídica corporativa</span>`,
    `</td></tr>`,
    `<tr><td style="height:3px;line-height:3px;font-size:0;background-color:${BRAND_GOLD};">&nbsp;</td></tr>`,
    // Content.
    `<tr><td style="padding:28px 24px 4px;">`,
    `<h1 style="margin:0 0 18px;font-family:${FONT};font-size:20px;line-height:28px;font-weight:bold;color:${BRAND_NAVY};">${htmlText(c.heading)}</h1>`,
    ...c.blocks.map(htmlBlock),
    `</td></tr>`,
    // Call to action.
    `<tr><td style="padding:4px 24px 28px;">`,
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>`,
    `<td style="background-color:${BRAND_NAVY};border-bottom:3px solid ${BRAND_GOLD};">`,
    `<a href="${url}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;">${htmlText(c.cta.label)}</a>`,
    `</td></tr></table>`,
    `<p style="margin:14px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:#64748b;">Se o botão não funcionar, copie o endereço: <span style="color:#334155;word-break:break-all;">${url}</span></p>`,
    `</td></tr>`,
    // Footer.
    `<tr><td style="padding:16px 24px;background-color:#f8fafc;border-top:1px solid #e2e8f0;font-family:${FONT};font-size:12px;line-height:18px;color:#64748b;">${escapeHtml(SIMULATION_FOOTER)}</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
    `</body>`,
    `</html>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Renders subject, plain text and HTML of a template. Data must already be validated (see `templateDataSchemas`). */
export function renderEmail<T extends EmailTemplate>(template: T, data: EmailTemplateDataMap[T], ctx: RenderContext): RenderedEmail {
  const builder = BUILDERS[template] as Builder<T>;
  const content = builder(data, { ...ctx, recipientName: clean(ctx.recipientName) || "usuário(a)" });
  return { subject: content.subject, text: renderText(content), html: renderHtml(content) };
}
