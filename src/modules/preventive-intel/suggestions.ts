/**
 * Illustrative preventive suggestions (pure, client-safe). Each suggestion is
 * triggered by a COMPUTED indicator and proposes a generic management measure
 * — labeled "Sugestão ilustrativa — avaliar com a área responsável". No legal
 * citation, case law or prediction is ever produced here.
 */
import { formatDate, formatPercent, pluralize } from "@/lib/format";
import { preventiveOriginMarker } from "@/modules/occurrences/preventive-origin";
import type { PreventiveIntelligence, PreventiveSuggestion } from "./types";

export const SUGGESTION_LABEL = "Sugestão ilustrativa — avaliar com a área responsável";

/** Reference thresholds of this version (fixed; shown next to each trigger). */
export const THRESHOLDS = {
  recurringClaimMinProcesses: 2,
  conciliationMinProcesses: 3,
  materializedMinShare: 0.2,
  materializedMinProcesses: 2,
  verificationMinShare: 0.05,
} as const;

/** "TRT-10" -> "trt-10"; used inside indicator keys. */
export function keySlug(value: string): string {
  return (
    value
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "sem-nome"
  );
}

type Indicators = Omit<PreventiveIntelligence, "suggestions" | "generatedAt" | "scope" | "filterSummary">;

/** Knowledge-phase processes per court (active portfolio), computed by the service. */
export type KnowledgeByCourt = { court: string; count: number; totalKnowledge: number };

export function buildSuggestions(ind: Indicators, knowledgeTop: KnowledgeByCourt | null): PreventiveSuggestion[] {
  const out: PreventiveSuggestion[] = [];
  const claims = ind.recurringClaims;
  const claimProcesses = (keys: string[]) =>
    claims.rows.filter((r) => keys.includes(r.key)).reduce((max, r) => Math.max(max, r.processCount), 0);
  const claimsBasis = `Pedidos recorrentes — ${pluralize(claims.briefsConsidered, "análise preliminar considerada", "análises preliminares consideradas")} (documentos fictícios de demonstração); limiar de referência: ${THRESHOLDS.recurringClaimMinProcesses} processos.`;

  const jornada = claimProcesses(["horas_extras", "intervalos"]);
  if (jornada >= THRESHOLDS.recurringClaimMinProcesses) {
    out.push({
      key: "jornada",
      title: "Revisão dos controles de jornada",
      trigger: `Pedidos de horas extras ou de intervalos aparecem em ${pluralize(jornada, "processo", "processos")} de ${claims.briefsConsidered} com análise preliminar.`,
      basis: claimsBasis,
      measure:
        "Revisar os controles de jornada (registro de ponto, banco de horas e concessão de intervalos) nas unidades e equipes com maior incidência, com apoio de RH e das lideranças.",
      planItems: [
        "Levantar registros de ponto e acordos de banco de horas das equipes envolvidas",
        "Conferir a concessão de intervalos nas escalas vigentes",
        "Apresentar diagnóstico a RH com proposta de ajustes nos controles",
      ],
    });
  }

  const rescisao = claimProcesses(["verbas_rescisorias", "fgts"]);
  if (rescisao >= THRESHOLDS.recurringClaimMinProcesses) {
    out.push({
      key: "rescisao",
      title: "Checklist de documentos rescisórios",
      trigger: `Pedidos de verbas rescisórias ou FGTS aparecem em ${pluralize(rescisao, "processo", "processos")} de ${claims.briefsConsidered} com análise preliminar.`,
      basis: claimsBasis,
      measure:
        "Adotar um checklist de documentos e pagamentos rescisórios (termo de rescisão, comprovantes de pagamento, guias de FGTS e de seguro-desemprego, aviso prévio) conferido antes de cada desligamento.",
      planItems: [
        "Montar o checklist de documentos rescisórios com RH e Departamento Pessoal",
        "Validar o checklist com a área jurídica",
        "Aplicar o checklist por amostragem nas rescisões dos últimos seis meses",
      ],
    });
  }

  if (knowledgeTop && knowledgeTop.count >= THRESHOLDS.conciliationMinProcesses) {
    out.push({
      key: `conciliacao:${keySlug(knowledgeTop.court)}`,
      title: `Programa de conciliação — ${knowledgeTop.court}`,
      trigger: `${pluralize(knowledgeTop.count, "processo ativo", "processos ativos")} em fase de conhecimento no ${knowledgeTop.court} (${formatPercent(knowledgeTop.count / Math.max(1, knowledgeTop.totalKnowledge))} dos processos em conhecimento).`,
      basis: `Concentração por tribunal na carteira ativa, fase de conhecimento; limiar de referência: ${THRESHOLDS.conciliationMinProcesses} processos.`,
      measure: `Avaliar um programa de conciliação para os processos em fase de conhecimento no ${knowledgeTop.court}, com critérios e alçadas definidos pela área jurídica e pela área financeira.`,
      planItems: [
        `Selecionar os processos elegíveis em fase de conhecimento no ${knowledgeTop.court}`,
        "Definir critérios e alçadas para propostas de acordo com a área financeira",
        "Acompanhar os resultados das tentativas de conciliação",
      ],
    });
  }

  const pd = ind.phaseDistribution;
  if (pd.materializedCount >= THRESHOLDS.materializedMinProcesses && pd.materializedShare >= THRESHOLDS.materializedMinShare) {
    out.push({
      key: "passivo-materializado",
      title: "Prioridade aos processos em liquidação e execução",
      trigger: `${pluralize(pd.materializedCount, "processo", "processos")} em liquidação ou execução (${formatPercent(pd.materializedShare)} da carteira ativa).`,
      basis: `Distribuição por fase na carteira ativa; limiar de referência: ${formatPercent(THRESHOLDS.materializedMinShare)}.`,
      measure:
        "Priorizar a conferência de cálculos, valores liquidados e garantias dos processos em liquidação ou execução, avaliando oportunidades de acordo.",
      planItems: [
        "Conferir cálculos e valores liquidados pendentes de conferência",
        "Verificar depósitos e garantias vinculados aos processos",
        "Avaliar propostas de acordo nos casos de maior valor liquidado",
      ],
    });
  }

  const rp = ind.repeatPlaintiffs;
  if (rp.plaintiffCount > 0) {
    out.push({
      key: "reclamantes-recorrentes",
      title: "Mapeamento de reclamantes com mais de um processo",
      trigger: `${pluralize(rp.plaintiffCount, "parte autora figura", "partes autoras figuram")} em mais de um processo (${pluralize(rp.processCount, "processo envolvido", "processos envolvidos")}).`,
      basis: "Reclamantes recorrentes — partes do polo ativo com o mesmo nome em mais de um processo visível.",
      measure:
        "Mapear se há origem comum (mesma unidade, gestão ou período) nos processos de reclamantes recorrentes e tratar a causa raiz com as áreas envolvidas.",
      planItems: [
        "Listar os processos dos reclamantes recorrentes e suas unidades de origem",
        "Identificar padrões comuns (gestão, período, pedidos)",
        "Definir medidas com as áreas envolvidas",
      ],
    });
  }

  const ca = ind.collectiveActions;
  if (ca.count > 0) {
    out.push({
      key: "acoes-coletivas",
      title: "Acompanhamento de ações coletivas e com o Ministério Público",
      trigger: `${pluralize(ca.count, "processo", "processos")} de natureza coletiva ou com participação do Ministério Público.`,
      basis: "Classe ACPCiv (ação civil pública) ou parte com papel “Ministério Público”.",
      measure:
        "Acompanhar com prioridade as ações coletivas e mapear o tema de cada uma junto às áreas envolvidas, para verificar se a situação descrita persiste.",
      planItems: [
        "Mapear o tema de cada ação coletiva com as áreas envolvidas",
        "Verificar se a situação descrita ainda ocorre",
        "Reportar a situação à diretoria",
      ],
    });
  }

  const v = ind.verification;
  if (v.count > 0 && v.share >= THRESHOLDS.verificationMinShare) {
    out.push({
      key: "saneamento-cadastral",
      title: "Saneamento dos cadastros marcados para verificação",
      trigger: `${pluralize(v.count, "processo marcado", "processos marcados")} para verificação (${formatPercent(v.share)} da carteira ativa).`,
      basis: `Cadastros a verificar na carteira ativa; limiar de referência: ${formatPercent(THRESHOLDS.verificationMinShare)}.`,
      measure: "Organizar um mutirão de conferência dos processos marcados para verificação, priorizando os de maior valor.",
      planItems: [
        "Distribuir os processos marcados para verificação entre os responsáveis",
        "Conferir os dados na fonte e corrigir os cadastros",
        "Registrar as correções e remover a marcação de verificação",
      ],
    });
  }

  return out;
}

/** Facts of an occurrence created from a suggestion (ends with the origin marker). */
export function buildSuggestionFacts(
  s: PreventiveSuggestion,
  opts: { today: string; filterSummary: string },
): string {
  return [
    `Ocorrência preventiva criada a partir de um indicador da inteligência preventiva em ${formatDate(opts.today)}.`,
    "",
    `Indicador: ${s.trigger}`,
    `Base do cálculo: ${s.basis}`,
    `Filtros aplicados: ${opts.filterSummary}`,
    "",
    `Medida sugerida (${SUGGESTION_LABEL.toLowerCase()}): ${s.measure}`,
    "",
    `Origem: inteligência preventiva ${preventiveOriginMarker(s.key)}`,
  ].join("\n");
}
