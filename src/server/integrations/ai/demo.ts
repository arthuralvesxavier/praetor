import type { AnalysisFinding, AnalysisOutput, FindingKind, SuggestedDeadline, SuggestedTask } from "@/domain/analysis";
import type { AnalysisType } from "@/domain/enums";
import type { AiAnalysisRequest, AiAnalysisResponse, AiProvider, AiSource } from "./provider";

/**
 * Deterministic demonstration provider. It does NOT use AI: simple text rules
 * (dates, R$ values, keywords) over the source texts. Every result says so in
 * `limitations`, and the analysis service adds DEMO_MODE_NOTICE as a system
 * notice. Used when no live provider is configured and in tests.
 */
export const DEMO_LIMITATION =
  "Resultado gerado em modo demonstrativo, sem uso de inteligência artificial: regras simples identificam apenas " +
  "padrões de texto (datas, valores e palavras-chave), podem gerar falsos positivos e omitir informações relevantes.";

type Severity = "low" | "medium" | "high" | "critical";

const RISK_KEYWORDS: { term: string; severity: Severity; action: string }[] = [
  { term: "vazamento de dados", severity: "critical", action: "Acionar o encarregado de dados (DPO) e avaliar a necessidade de comunicação à ANPD e aos titulares." },
  { term: "assédio", severity: "critical", action: "Encaminhar o relato ao canal de compliance e preservar as evidências, com acompanhamento do RH." },
  { term: "acidente", severity: "high", action: "Reunir comunicações internas, CAT e relatórios de segurança relacionados ao evento." },
  { term: "notificação extrajudicial", severity: "high", action: "Registrar a data de recebimento da notificação e avaliar a resposta com o advogado responsável." },
  { term: "ação judicial", severity: "high", action: "Verificar se já existe processo cadastrado e reunir os documentos de defesa." },
  { term: "rescisão", severity: "high", action: "Revisar as cláusulas de rescisão e os avisos prévios aplicáveis." },
  { term: "indenização", severity: "high", action: "Levantar a base de cálculo dos valores mencionados e avaliar provisionamento com o jurídico." },
  { term: "inadimplência", severity: "high", action: "Conferir os pagamentos pendentes e o histórico de cobrança com o financeiro." },
  { term: "descumprimento", severity: "high", action: "Mapear as obrigações descumpridas e documentar as tratativas com a outra parte." },
  { term: "multa", severity: "medium", action: "Identificar a cláusula ou norma que prevê a multa e os valores envolvidos." },
  { term: "penalidade", severity: "medium", action: "Verificar as condições de aplicação da penalidade mencionada." },
  { term: "protesto", severity: "medium", action: "Verificar a existência de títulos protestados e a regularidade dos pagamentos." },
  { term: "reclamação", severity: "medium", action: "Registrar a reclamação, responder ao reclamante e avaliar a causa raiz." },
];

const INJECTION_PHRASES = [
  "ignore as instrucoes",
  "ignore todas as instrucoes",
  "ignore as orientacoes",
  "ignore previous instructions",
  "ignore all previous instructions",
  "ignore the above",
  "disregard previous instructions",
  "desconsidere as instrucoes",
  "desconsidere todas as instrucoes",
  "voce e um assistente",
  "you are an ai",
  "you are a helpful assistant",
  "system prompt",
  "prompt do sistema",
  "classifique como",
];

const MONTHS: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

const STOPWORDS = new Set(
  "a o as os de da do das dos e em no na nos nas um uma uns umas para por com sem que qual quais quando onde como sobre entre ao aos pelo pela pelos pelas se ha foi sao ser esta este essa esse isso isto existe existem algum alguma tem possui qual quem mais menos ja nao sim ou the of and to".split(
    " ",
  ),
);

const RECORD_KINDS = new Set(["legal_process", "occurrence", "contract"]);

/** Lower-case and strip diacritics while keeping a 1:1 character mapping with the input. */
export function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const base = lower.length === ch.length ? lower : ch;
    const stripped = base.normalize("NFD").replace(/\p{M}/gu, "");
    out += stripped.length === base.length ? stripped : base;
  }
  return out;
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function toIso(day: number, month: number, year: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 2);
}

function clip(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The sentence/line around a match, used as a literal excerpt. */
function contextAround(text: string, index: number, length: number): string {
  const start = Math.max(
    text.lastIndexOf("\n", index) + 1,
    Math.max(text.lastIndexOf(". ", index) + 2, 0),
    index - 160,
  );
  let end = text.length;
  for (const sep of ["\n", ". "]) {
    const p = text.indexOf(sep, index + length);
    if (p >= 0 && p + 1 < end) end = p + 1;
  }
  end = Math.min(end, index + length + 160);
  return clip(text.slice(start, end));
}

type Collected = {
  dates: { ref: string; iso: string; excerpt: string; label: string; literal: string }[];
  amounts: { ref: string; value: string; excerpt: string }[];
  risks: { ref: string; term: string; severity: Severity; excerpt: string; count: number; action: string }[];
  missingInfo: { ref: string; field: string; excerpt: string }[];
  obligations: { ref: string; excerpt: string }[];
  labelValues: Map<string, { display: string; values: Map<string, { refs: Set<string>; raw: string }> }>;
};

function collect(sources: AiSource[]): Collected {
  const c: Collected = { dates: [], amounts: [], risks: [], missingInfo: [], obligations: [], labelValues: new Map() };
  const seenDates = new Set<string>();
  const seenAmounts = new Set<string>();

  for (const s of sources) {
    const text = s.text;
    const folded = fold(text);

    // Dates: dd/mm/aaaa
    for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
      const iso = toIso(Number(m[1]), Number(m[2]), Number(m[3]));
      if (!iso || seenDates.has(`${s.ref}:${iso}`)) continue;
      seenDates.add(`${s.ref}:${iso}`);
      c.dates.push({ ref: s.ref, iso, literal: m[0], excerpt: contextAround(text, m.index ?? 0, m[0].length), label: s.label });
    }
    // Dates: "dd de <mês> de aaaa"
    for (const m of folded.matchAll(/\b(\d{1,2})(?:º|o)?\s+de\s+([a-z]+)\s+de\s+(\d{4})\b/g)) {
      const month = MONTHS[m[2]];
      if (!month) continue;
      const iso = toIso(Number(m[1]), month, Number(m[3]));
      if (!iso || seenDates.has(`${s.ref}:${iso}`)) continue;
      seenDates.add(`${s.ref}:${iso}`);
      const idx = m.index ?? 0;
      c.dates.push({
        ref: s.ref,
        iso,
        literal: text.slice(idx, idx + m[0].length),
        excerpt: contextAround(text, idx, m[0].length),
        label: s.label,
      });
    }
    // Amounts in R$
    for (const m of text.matchAll(/R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?|R\$\s?\d+(?:,\d{2})?/g)) {
      const value = m[0].replace(/\s+/g, " ");
      if (seenAmounts.has(`${s.ref}:${value}`)) continue;
      seenAmounts.add(`${s.ref}:${value}`);
      c.amounts.push({ ref: s.ref, value, excerpt: contextAround(text, m.index ?? 0, m[0].length) });
    }
    // Risk keywords
    for (const kw of RISK_KEYWORDS) {
      const needle = fold(kw.term);
      let idx = folded.indexOf(needle);
      if (idx < 0) continue;
      const first = idx;
      let count = 0;
      while (idx >= 0) {
        count++;
        idx = folded.indexOf(needle, idx + needle.length);
      }
      c.risks.push({
        ref: s.ref,
        term: kw.term,
        severity: kw.severity,
        count,
        action: kw.action,
        excerpt: contextAround(text, first, needle.length),
      });
    }
    // "Campo: não informado"
    for (const m of text.matchAll(/^[ \t-]*([^:\n]{2,60}):[ \t]*(não informad[oa]|não consta|a definir|pendente de informação)[ \t.]*$/gim)) {
      c.missingInfo.push({ ref: s.ref, field: m[1].trim(), excerpt: clip(m[0]) });
    }
    // "Campo: valor" pairs for inconsistency detection
    for (const m of text.matchAll(/^[ \t-]*([A-Za-zÀ-ÿ][^:\n]{1,40}):[ \t]*([^\n]{1,120})$/gm)) {
      const key = fold(m[1].trim());
      const raw = m[2].trim();
      const value = fold(raw).replace(/\s+/g, " ").replace(/[.;]$/, "");
      if (!value || /^(nao informad[oa]|nao consta|a definir|-)$/.test(value)) continue;
      let entry = c.labelValues.get(key);
      if (!entry) {
        entry = { display: m[1].trim(), values: new Map() };
        c.labelValues.set(key, entry);
      }
      const v = entry.values.get(value) ?? { refs: new Set<string>(), raw };
      v.refs.add(s.ref);
      entry.values.set(value, v);
    }
    // Obligations ("deverá", "obriga-se")
    for (const sentence of splitSentences(text)) {
      if (/\b(deverá|deverão|obriga-se|obrigam-se|fica obrigad[oa])\b/i.test(sentence)) {
        c.obligations.push({ ref: s.ref, excerpt: clip(sentence) });
      }
    }
  }
  return c;
}

function questionAnswer(sources: AiSource[], question: string): { answer: string; findings: AnalysisFinding[] } {
  const terms = Array.from(
    new Set(
      fold(question)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 4 && !STOPWORDS.has(t)),
    ),
  );
  const scored: { ref: string; sentence: string; score: number; order: number }[] = [];
  let order = 0;
  for (const s of sources) {
    for (const sentence of splitSentences(s.text)) {
      const f = fold(sentence);
      const score = terms.filter((t) => f.includes(t)).length;
      if (score > 0) scored.push({ ref: s.ref, sentence, score, order: order++ });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const top = scored.slice(0, 3);
  if (!terms.length || !top.length) {
    return { answer: "Não foram encontradas informações sobre isso nas fontes acessíveis.", findings: [] };
  }
  const answer =
    "Trechos possivelmente relacionados encontrados nas fontes: " +
    top.map((t) => `[${t.ref}] "${clip(t.sentence, 220)}"`).join("; ") +
    ". Leia as fontes completas para confirmar se respondem à pergunta.";
  const findings: AnalysisFinding[] = top.map((t) => ({
    kind: "fact",
    title: "Trecho relacionado à pergunta",
    detail: "Trecho selecionado por coincidência de palavras com a pergunta (sem interpretação).",
    severity: null,
    sourceRefs: [t.ref],
    excerpt: clip(t.sentence),
  }));
  return { answer, findings };
}

const KINDS_BY_TYPE: Record<AnalysisType, FindingKind[]> = {
  summary: ["key_date", "amount", "risk_signal"],
  extraction: ["key_date", "amount", "obligation"],
  risk_signals: ["risk_signal", "missing_information", "missing_document"],
  inconsistencies: ["inconsistency", "missing_document", "pending_obligation", "missing_information"],
  preventive_actions: ["risk_signal", "preventive_action"],
  question_answer: [],
};

export class DemoProvider implements AiProvider {
  readonly name = "demo";
  readonly mode = "demo" as const;
  readonly model = "regras-demonstrativas-v1";

  async analyze(req: AiAnalysisRequest): Promise<AiAnalysisResponse> {
    return { output: this.run(req), usage: { inputTokens: 0, outputTokens: 0 } };
  }

  run(req: AiAnalysisRequest): AnalysisOutput {
    const sources = req.sources;
    const refs = new Set(sources.map((s) => s.ref));
    const limitations = [DEMO_LIMITATION];
    const validationPoints = [
      "Confirme cada item diretamente nas fontes indicadas antes de utilizá-lo.",
      "As datas sugeridas foram apenas copiadas do texto; um advogado deve verificar se correspondem a prazos e calcular eventuais prazos processuais.",
    ];

    const allFolded = sources.map((s) => fold(s.text)).join("\n");
    const promptInjectionSuspected = INJECTION_PHRASES.some((p) => allFolded.includes(p));
    if (promptInjectionSuspected) {
      limitations.push("As fontes contêm textos com instruções direcionadas a sistemas de IA; esses textos foram tratados apenas como dados.");
    }

    if (!sources.length) {
      limitations.push("Nenhuma fonte com texto disponível foi fornecida para a análise.");
      return {
        summary: "Não há fontes com texto disponível para análise.",
        answer: req.type === "question_answer" ? "Não foram encontradas informações sobre isso nas fontes acessíveis." : null,
        findings: [],
        suggestedDeadlines: [],
        suggestedTasks: [],
        limitations,
        validationPoints,
        promptInjectionSuspected,
      };
    }

    const c = collect(sources);
    const today = todayIso();
    const all: AnalysisFinding[] = [];

    for (const d of c.dates.slice(0, 12)) {
      all.push({
        kind: "key_date",
        title: `Data mencionada: ${d.literal}`,
        detail: `Data citada em ${d.ref}.`,
        severity: null,
        sourceRefs: [d.ref],
        excerpt: d.excerpt,
      });
    }
    for (const a of c.amounts.slice(0, 12)) {
      all.push({
        kind: "amount",
        title: `Valor mencionado: ${a.value}`,
        detail: `Valor citado em ${a.ref}.`,
        severity: null,
        sourceRefs: [a.ref],
        excerpt: a.excerpt,
      });
    }
    for (const r of c.risks.slice(0, 15)) {
      all.push({
        kind: "risk_signal",
        title: `Menção a "${r.term}"`,
        detail: `O termo aparece ${r.count} vez(es) em ${r.ref}. Avalie o contexto na fonte.`,
        severity: r.severity,
        sourceRefs: [r.ref],
        excerpt: r.excerpt,
      });
    }
    for (const m of c.missingInfo.slice(0, 10)) {
      all.push({
        kind: "missing_information",
        title: `Informação não preenchida: ${m.field}`,
        detail: `O campo "${m.field}" consta como não informado em ${m.ref}.`,
        severity: "medium",
        sourceRefs: [m.ref],
        excerpt: m.excerpt,
      });
    }
    const hasDocuments = sources.some((s) => s.kind === "document_version");
    if (!hasDocuments) {
      for (const s of sources.filter((x) => RECORD_KINDS.has(x.kind)).slice(0, 1)) {
        all.push({
          kind: "missing_document",
          title: "Nenhum documento com texto vinculado",
          detail: "A análise considerou apenas os dados cadastrados; não há documentos com texto extraído vinculados ao registro.",
          severity: "medium",
          sourceRefs: [s.ref],
          excerpt: null,
        });
      }
    }
    let inconsistencies = 0;
    for (const entry of c.labelValues.values()) {
      if (entry.values.size < 2 || inconsistencies >= 5) continue;
      const vals = Array.from(entry.values.values());
      const refsUsed = Array.from(new Set(vals.flatMap((v) => Array.from(v.refs))));
      inconsistencies++;
      all.push({
        kind: "inconsistency",
        title: `Valores diferentes para "${entry.display}"`,
        detail: `Foram encontrados valores distintos: ${vals
          .slice(0, 4)
          .map((v) => `"${clip(v.raw, 60)}" (${Array.from(v.refs).join(", ")})`)
          .join(" e ")}.`,
        severity: "medium",
        sourceRefs: refsUsed,
        excerpt: null,
      });
    }
    for (const o of c.obligations.slice(0, 8)) {
      all.push({
        kind: "pending_obligation",
        title: "Obrigação mencionada",
        detail: `Trecho com obrigação a cumprir em ${o.ref}; verifique se já foi cumprida.`,
        severity: null,
        sourceRefs: [o.ref],
        excerpt: o.excerpt,
      });
      if (req.type === "extraction") {
        all.push({
          kind: "obligation",
          title: "Obrigação identificada",
          detail: `Trecho com obrigação em ${o.ref}.`,
          severity: null,
          sourceRefs: [o.ref],
          excerpt: o.excerpt,
        });
      }
    }
    for (const r of c.risks.slice(0, 8)) {
      all.push({
        kind: "preventive_action",
        title: `Ação preventiva relacionada a "${r.term}"`,
        detail: r.action,
        severity: null,
        sourceRefs: [r.ref],
        excerpt: null,
      });
    }

    const wanted = new Set(KINDS_BY_TYPE[req.type]);
    let findings = all.filter((f) => wanted.has(f.kind));
    let answer: string | null = null;

    if (req.type === "question_answer") {
      const qa = questionAnswer(sources, req.question ?? "");
      answer = qa.answer;
      findings = qa.findings;
    }

    const suggestedDeadlines: SuggestedDeadline[] =
      req.type === "question_answer" || req.type === "preventive_actions"
        ? []
        : c.dates
            .filter((d) => d.iso > today)
            .slice(0, 10)
            .map((d) => ({
              title: `Data mencionada em ${d.ref}: ${d.literal}`,
              date: d.iso,
              sourceRef: d.ref,
              excerpt: d.excerpt,
              rationale: "Data futura citada literalmente na fonte. Confirme se corresponde a um prazo antes de validar.",
            }));

    const suggestedTasks: SuggestedTask[] =
      req.type === "risk_signals" || req.type === "preventive_actions"
        ? c.risks
            .filter((r) => r.severity === "high" || r.severity === "critical")
            .slice(0, 5)
            .map((r) => ({
              title: `Avaliar menção a "${r.term}"`,
              description: r.action,
              priority: r.severity === "critical" ? ("urgent" as const) : ("high" as const),
              sourceRefs: [r.ref],
            }))
        : [];

    const summaryParts = sources.slice(0, 6).map((s) => {
      const first = splitSentences(s.text).slice(0, 2).join(" ");
      return `${s.ref} (${clip(s.label, 80)}): ${clip(first, 280)}`;
    });
    const counts: string[] = [];
    if (c.dates.length) counts.push(`${c.dates.length} data(s)`);
    if (c.amounts.length) counts.push(`${c.amounts.length} valor(es)`);
    if (c.risks.length) counts.push(`${c.risks.length} termo(s) de risco`);
    const summary =
      `Resumo demonstrativo (sem IA) de ${sources.length} fonte(s). ` +
      (counts.length ? `Foram encontrados ${counts.join(", ")}. ` : "") +
      summaryParts.join(" | ");

    // Defensive: every ref must exist.
    const valid = (r: string) => refs.has(r);
    return {
      summary,
      answer,
      findings: findings.filter((f) => f.sourceRefs.length && f.sourceRefs.every(valid)),
      suggestedDeadlines: suggestedDeadlines.filter((d) => valid(d.sourceRef)),
      suggestedTasks: suggestedTasks.filter((t) => t.sourceRefs.every(valid)),
      limitations,
      validationPoints,
      promptInjectionSuspected,
    };
  }
}
