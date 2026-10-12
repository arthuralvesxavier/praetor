import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { isValidCnj } from "@/domain/cnj";
import { ISSUE_LEVEL_LABELS } from "@/domain/enums";
import { ISSUE_CODE_LABELS } from "@/modules/imports/labels";

/**
 * Public landing page (src/app/page.tsx) rendered with react-dom/server.
 *
 * Copy rules from the product owner: no dash used as punctuation (em dash or
 * spaced en dash), no "Perfis" or "Simulações" sections, a "Por que Praetor"
 * section, the real "Como funciona" flow with the demo-mode footnote and an FAQ
 * about the platform. Illustrative CNJ numbers must have valid check digits.
 *
 * Set LANDING_PREVIEW_DIR to also write the rendered markup (page and every
 * preview tab and flow step) for a visual check with compiled CSS.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => ({
  getCurrentUser: async () => null,
  requirePageContext: async () => {
    throw new Error("not used");
  },
  requireActionContext: async () => {
    throw new Error("not used");
  },
}));

const { default: LandingPage, metadata } = await import("@/app/page");
const { ProductPreview } = await import("@/components/landing/product-preview");
const { FlowStepper } = await import("@/components/landing/flow-stepper");

const DASHES = /[—–]/;

/** Block titles of the real "Exige decisão agora" band, in order. */
const DECISION_BAND_TITLES = [
  "Audiências",
  "Prazos fatais",
  "Parcelas de acordo a vencer",
  "Garantias sem movimentação",
  "Valores pendentes de conferência",
];
const CNJ_PATTERN = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/g;

function decode(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Visible text (tags removed), whitespace collapsed. */
function textOf(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

let html = "";
let text = "";
const previews: string[] = [];
const steps: string[] = [];

beforeAll(async () => {
  html = renderToStaticMarkup((await LandingPage()) as ReactElement);
  text = textOf(html);
  for (let i = 0; i < 4; i++) previews.push(renderToStaticMarkup(createElement(ProductPreview, { initialTab: i })));
  for (let i = 0; i < 6; i++) steps.push(renderToStaticMarkup(createElement(FlowStepper, { initialStep: i })));

  const outDir = process.env.LANDING_PREVIEW_DIR;
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "page.fragment.html"), html, "utf8");
    previews.forEach((p, i) => writeFileSync(path.join(outDir, `preview-${i}.fragment.html`), p, "utf8"));
    steps.forEach((s, i) => writeFileSync(path.join(outDir, `step-${i}.fragment.html`), s, "utf8"));
  }
});

describe("landing page copy", () => {
  it("uses no em dash or spaced en dash, in the page, the screens or the metadata", () => {
    expect(html).not.toMatch(DASHES);
    expect(text).not.toContain(" - ");
    for (const fragment of [...previews, ...steps]) expect(fragment).not.toMatch(DASHES);
    const title = typeof metadata.title === "object" && metadata.title && "absolute" in metadata.title ? metadata.title.absolute : metadata.title;
    expect(String(title)).not.toMatch(DASHES);
    expect(String(metadata.description)).not.toMatch(DASHES);
  });

  it("turns off the tabular figures of the body, which make Inter draw 'e-mail' as 'e - mail'", () => {
    // globals.css sets `font-variant-numeric: tabular-nums` on body; Inter's tnum
    // feature swaps the hyphen for a wide glyph. The landing root resets it.
    const rootClasses = (markup: string) => (markup.match(/^<div class="([^"]*)"/)?.[1] ?? "").split(" ");
    expect(rootClasses(html)).toContain("normal-nums");
    // The screens also reset it themselves, so they render right wherever they are used.
    expect(rootClasses(previews[0])).toContain("normal-nums");
    expect(rootClasses(steps[0])).toContain("normal-nums");
  });

  it("keeps the landing sources free of dashes used as punctuation", () => {
    const dir = path.resolve("src/components/landing");
    const files = [path.resolve("src/app/page.tsx"), ...readdirSync(dir).map((f) => path.join(dir, f))];
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(DASHES);
  });

  it("has no Perfis or Simulações sections, nor links to them", () => {
    expect(html).not.toContain('id="perfis"');
    expect(html).not.toContain('id="simulacoes"');
    expect(html).not.toContain('href="#perfis"');
    expect(html).not.toContain('href="#simulacoes"');
    expect(text).not.toMatch(/\bPerfis\b/);
    expect(text).not.toMatch(/Simulações/);
  });

  it("explains the name in a 'Por que Praetor' section", () => {
    expect(html).toContain('id="por-que-praetor"');
    expect(html).toContain('href="#por-que-praetor"');
    expect(text).toContain("Por que Praetor");
    expect(text).toMatch(/magistrado encarregado de administrar a justiça/);
    expect(text).toMatch(/edito/);
  });

  it("shows the real flow in 'Como funciona' with the demo-mode footnote", () => {
    expect(html).toContain('id="como-funciona"');
    expect(text).toContain("Como funciona");
    for (const title of [
      "A carteira entra",
      "O processo vai para o responsável",
      "Os documentos são lidos",
      "O advogado recebe o aviso",
      "Revisão e aprovação",
      "Valores e fechamento do mês",
    ]) {
      expect(text).toContain(title);
    }
    expect(text).toContain(
      "Nesta versão, a leitura automática dos documentos e o envio de e-mails funcionam em modo de demonstração.",
    );
  });

  it("keeps the demo-mode note out of the footer", () => {
    const footer = textOf(html.slice(html.indexOf("<footer")));
    expect(footer).not.toMatch(/demonstração|tribunais/);
  });

  it("answers the platform FAQ", () => {
    expect(html).toContain('id="perguntas"');
    for (const q of [
      "De onde vêm os processos?",
      "Por que o valor da causa e o valor apurado nunca são somados?",
      "O que acontece quando falta um dado?",
      "Quem vê o quê?",
      "Como funciona o fechamento mensal?",
      "A análise preliminar substitui o advogado?",
      "O escritório externo tem acesso ao sistema?",
      "Como ficam a segurança e a LGPD?",
      "Dá para exportar para Excel?",
    ]) {
      expect(text).toContain(q);
    }
  });

  it("does not promise integrations or real AI that are not delivered", () => {
    expect(text).not.toMatch(/DataJud|Power BI|inteligência artificial/i);
    // Statements about tribunal consultation would go stale as soon as it ships.
    expect(text).not.toMatch(/consulta automática a tribunais|integração com tribunais/i);
    expect(text).not.toMatch(/A plataforma em números/);
  });
});

describe("product preview and flow screens", () => {
  it("label the data as illustrative and render the four screens", () => {
    for (const p of previews) expect(textOf(p)).toContain("Dados ilustrativos");
    expect(textOf(previews[0])).toContain("Exige decisão agora");
    for (const block of DECISION_BAND_TITLES) expect(textOf(previews[0])).toContain(block);
    // As in the real dashboard, coverage opens "Carteira de passivo", outside the decision band.
    const panel = textOf(previews[0]);
    expect(panel.indexOf("Cobertura do valor apurado")).toBeGreaterThan(panel.indexOf("Carteira de passivo"));
    expect(textOf(previews[1])).toContain("Carteira de processos");
    expect(textOf(previews[2])).toContain("Capa do processo");
    expect(textOf(previews[3])).toContain("Entrada de processos");
    for (const s of steps) expect(textOf(s)).toContain("Tela ilustrativa");
  });

  it("keep valor da causa and valor apurado apart and show Não apurado", () => {
    const portfolio = textOf(previews[1]);
    expect(portfolio).toContain("Valor da causa");
    expect(portfolio).toContain("Valor liquidado");
    expect(portfolio).toContain("Não apurado");
    expect(textOf(previews[2])).toContain("Não apurado");
  });

  it("use the block titles of the real dashboard band, in the same order", () => {
    const real = readFileSync(path.resolve("src/modules/dashboard/components/decision-band.tsx"), "utf8");
    const realTitles = [...real.matchAll(/^ {4}title: "([^"]+)",$/gm)].map((m) => m[1]);
    expect(realTitles).toEqual(DECISION_BAND_TITLES);
    const all = textOf(previews[0]);
    const panel = all.slice(all.indexOf("Exige decisão agora"));
    const positions = DECISION_BAND_TITLES.map((t) => panel.indexOf(t));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    // The old shortened titles are gone.
    for (const old of ["Audiências em 7 dias", "Garantias paradas", "Valores a conferir"]) expect(panel).not.toContain(old);
  });

  it("show import issues with the real codes and levels of the parser", () => {
    const importScreen = textOf(steps[0]);
    const row = (level: keyof typeof ISSUE_LEVEL_LABELS, code: keyof typeof ISSUE_CODE_LABELS) =>
      new RegExp(`${ISSUE_LEVEL_LABELS[level]} Linha \\d+ ${ISSUE_CODE_LABELS[code]}`);
    expect(importScreen).toMatch(row("error", "cnj_invalid_format"));
    expect(importScreen).toMatch(row("warning", "cnj_invalid_check_digit"));
    expect(importScreen).toMatch(row("warning", "duplicate_in_sheet"));
    expect(importScreen).toMatch(row("info", "court_derived"));
    // The parser skips a repeated number (warning level), so the legend must not say every alert is imported.
    expect(importScreen).toContain("Erro e número repetido: linha não importada.");
    expect(importScreen).not.toContain("Alerta: conferir.");
  });

  it("use CNJ numbers with valid check digits", () => {
    const all = [html, ...previews, ...steps].join(" ");
    const numbers = [...new Set(all.match(CNJ_PATTERN) ?? [])];
    expect(numbers.length).toBeGreaterThanOrEqual(5);
    for (const n of numbers) expect(isValidCnj(n), n).toBe(true);
  });
});
