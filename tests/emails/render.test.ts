import { describe, expect, it } from "vitest";
import { CASE_BRIEF_DEMO_NOTICE } from "@/domain/case-brief";
import { EMAIL_TEMPLATES, type EmailTemplate } from "@/domain/enums";
import {
  absoluteUrl,
  buildSubject,
  escapeHtml,
  renderEmail,
  safeUrl,
  SIMULATION_BANNER,
  SUBJECT_PREFIX,
} from "@/modules/emails/render";
import { isAppPath, templateDataSchemas } from "@/modules/emails/schemas";
import type { EmailTemplateDataMap } from "@/modules/emails/templates";

const ctx = {
  recipientName: "Laura Advogada",
  linkUrl: "http://localhost:3000/processos/abc?aba=analise-preliminar",
  appUrl: "http://localhost:3000",
  now: new Date("2026-10-11T12:00:00Z"),
};

const SAMPLE: EmailTemplateDataMap = {
  case_brief_ready: {
    processNumber: "00012345620265100001",
    processTitle: "Reclamação trabalhista — Autor Fictício x Empresa Modelo",
    court: "1ª Vara do Trabalho de Palmas",
    parties: "Autor Fictício x EMPRESA MODELO TESTE LTDA",
    headline: "Pedido de horas extras e adicional de insalubridade.",
    urgencies: ["Audiência inicial designada"],
    possibleDeadlines: [{ description: "Contestação", date: "2026-10-20" }, { description: "Manifestação", date: null }],
    gapsCount: 2,
    missingDocumentsCount: 1,
    isDemo: true,
    briefVersion: 1,
  },
  intake_assigned: {
    processNumber: "0001234-56.2026.5.10.0001",
    processTitle: "Processo fictício",
    court: null,
    assignmentReason: "Regra por tribunal (TRT-10) e menor carga.",
    receivedAt: "2026-10-11T13:30:00.000Z",
  },
  deadline_reminder: { title: "Contestação", dueDate: "2026-10-20", processNumber: null, pendingValidation: true },
  hearing_reminder: {
    processNumber: "0001234-56.2026.5.10.0001",
    processTitle: "Processo fictício",
    kindLabel: "Audiência inicial",
    modeLabel: "Telepresencial",
    scheduledAt: "2026-10-20T17:00:00.000Z",
    location: null,
  },
  daily_digest: {
    items: [
      { label: "Alertas abertos", count: 3, path: "/alertas?situacao=abertos" },
      { label: "Prazos vencidos", count: 0, path: "/prazos?aba=prazos&situacao=vencidos" },
    ],
  },
  brief_approved: {
    processNumber: "0001234-56.2026.5.10.0001",
    processTitle: "Processo fictício",
    approvedByName: "Gustavo Gestor",
    briefVersion: 2,
  },
};

describe("renderEmail", () => {
  it.each(EMAIL_TEMPLATES)("%s: [Simulação] subject, banner in both bodies, branding and absolute link", (template) => {
    const r = renderEmail(template as EmailTemplate, SAMPLE[template as EmailTemplate] as never, ctx);
    expect(r.subject.startsWith(`${SUBJECT_PREFIX} `)).toBe(true);
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.text.split("\n").slice(0, 3).join("\n")).toContain(SIMULATION_BANNER);
    expect(r.html).toContain(SIMULATION_BANNER);
    // Banner comes before the brand header.
    expect(r.html.indexOf(SIMULATION_BANNER)).toBeLessThan(r.html.indexOf("PRAETOR"));
    expect(r.html).toContain("#0B1A2C");
    expect(r.html).toContain("#D4B062");
    expect(r.html).toContain('<table role="presentation"');
    expect(r.html).not.toMatch(/<script/i);
    expect(r.text).toContain(ctx.linkUrl);
    expect(r.html).toContain(escapeHtml(ctx.linkUrl));
    expect(r.text).toContain("Laura Advogada");
  });

  it("formats the CNJ number in the brief subject", () => {
    const r = renderEmail("case_brief_ready", SAMPLE.case_brief_ready, ctx);
    expect(r.subject).toBe("[Simulação] Análise preliminar disponível — Proc. 0001234-56.2026.5.10.0001");
  });

  it("labels demo-mode briefs and omits the notice otherwise", () => {
    const demo = renderEmail("case_brief_ready", SAMPLE.case_brief_ready, ctx);
    expect(demo.text).toContain(CASE_BRIEF_DEMO_NOTICE);
    expect(demo.html).toContain(escapeHtml(CASE_BRIEF_DEMO_NOTICE));
    expect(demo.html).toContain("Análise demonstrativa · "); // preview line
    const real = renderEmail("case_brief_ready", { ...SAMPLE.case_brief_ready, isDemo: false }, ctx);
    expect(real.text).not.toContain(CASE_BRIEF_DEMO_NOTICE);
    expect(real.html).not.toContain("ANÁLISE DEMONSTRATIVA");
    expect(real.html).not.toContain("Análise demonstrativa");
    // Possible deadlines are always "a conferir" and missing dates are said so.
    expect(real.text).toContain("Possíveis prazos a conferir");
    expect(real.text).toContain("Contestação — 20/10/2026");
    expect(real.text).toContain("Manifestação — data não identificada");
  });

  it("flags AI-suggested deadlines that still need validation", () => {
    const r = renderEmail("deadline_reminder", SAMPLE.deadline_reminder, ctx);
    expect(r.text).toContain("aguarda validação humana");
    expect(r.subject).toBe("[Simulação] Lembrete de prazo — Contestação (20/10/2026)");
    const confirmed = renderEmail("deadline_reminder", { ...SAMPLE.deadline_reminder, pendingValidation: false }, ctx);
    expect(confirmed.text).not.toContain("aguarda validação humana");
  });

  it("shows hearing time in Brasília time", () => {
    const r = renderEmail("hearing_reminder", SAMPLE.hearing_reminder, ctx);
    expect(r.text).toContain("20/10/2026 14:00");
    expect(r.text).toContain("Local: Não informado");
  });

  it("digest items become absolute links with their counts", () => {
    const r = renderEmail("daily_digest", SAMPLE.daily_digest, ctx);
    expect(r.subject).toBe("[Simulação] Resumo diário de pendências — 11/10/2026");
    expect(r.text).toContain("Alertas abertos: 3 (http://localhost:3000/alertas?situacao=abertos)");
    expect(r.html).toContain('href="http://localhost:3000/prazos?aba=prazos&amp;situacao=vencidos"');
  });

  it("escapes every interpolated value", () => {
    const evil = `<img src=x onerror="alert(1)"> & 'x' \`y\``;
    const r = renderEmail(
      "case_brief_ready",
      {
        ...SAMPLE.case_brief_ready,
        processTitle: evil,
        parties: `<script>alert(1)</script>`,
        headline: evil,
        urgencies: [evil],
        possibleDeadlines: [{ description: evil, date: null }],
        court: `"><b>tribunal</b>`,
      },
      { ...ctx, recipientName: "<i>Laura</i>" },
    );
    expect(r.html).not.toContain("<img");
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<b>tribunal</b>");
    expect(r.html).not.toContain("<i>Laura</i>");
    expect(r.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;x&#39; &#96;y&#96;");
    expect(r.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // The plain-text version keeps the literal characters (it is never rendered as HTML).
    expect(r.text).toContain(evil);
  });

  it("never lets a value break the subject line", () => {
    const r = renderEmail("deadline_reminder", { ...SAMPLE.deadline_reminder, title: "Prazo\r\nBcc: alguem@exemplo.com" }, ctx);
    expect(r.subject).toBe("[Simulação] Lembrete de prazo — Prazo Bcc: alguem@exemplo.com (20/10/2026)");
    expect(buildSubject("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });

  it("only allows absolute http(s) links", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("#");
    expect(safeUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(safeUrl('http://x/"onmouseover=1')).toBe("#");
    const r = renderEmail("brief_approved", SAMPLE.brief_approved, { ...ctx, linkUrl: "javascript:alert(1)" });
    expect(r.html).not.toContain("javascript:");
    expect(absoluteUrl("http://localhost:3000/", "/emails")).toBe("http://localhost:3000/emails");
  });
});

describe("template data schemas", () => {
  it("accepts app paths only", () => {
    expect(isAppPath("/processos/1?aba=emails")).toBe(true);
    expect(isAppPath("//evil.example")).toBe(false);
    expect(isAppPath("https://evil.example")).toBe(false);
    expect(isAppPath("/a b")).toBe(false);
  });

  it("clips long strings and caps lists instead of failing", () => {
    const parsed = templateDataSchemas.case_brief_ready.parse({
      ...SAMPLE.case_brief_ready,
      processTitle: "t".repeat(1000),
      urgencies: Array.from({ length: 40 }, (_, i) => `item ${i}`),
    });
    expect(parsed.processTitle.length).toBe(300);
    expect(parsed.urgencies).toHaveLength(12);
  });

  it("rejects structurally invalid data", () => {
    expect(templateDataSchemas.deadline_reminder.safeParse({ title: "x", dueDate: "20/10/2026" }).success).toBe(false);
    expect(templateDataSchemas.daily_digest.safeParse({ items: [{ label: "x", count: 1, path: "https://evil" }] }).success).toBe(false);
  });
});
