/**
 * Domain enumerations shared by server and client code.
 *
 * Technical identifiers are in English; `*_LABELS` maps hold the pt-BR text
 * shown in the interface. Persisted as `text` columns (see ADR-0003): adding a
 * value here does not require a database migration, but removing or renaming
 * one does require a data migration.
 */

function labels<const T extends readonly string[]>(
  _values: T,
  map: { [K in T[number]]: string },
) {
  return map;
}

// ---------------------------------------------------------------------------
// Users & access
// ---------------------------------------------------------------------------

export const ROLES = [
  "admin",
  "legal_manager",
  "lawyer",
  "analyst",
  "executive",
  "accountant",
  "auditor",
  "external_counsel",
] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS = labels(ROLES, {
  admin: "Administrador",
  legal_manager: "Gestor jurídico",
  lawyer: "Advogado",
  analyst: "Analista",
  executive: "Diretoria / executivo",
  accountant: "Contabilidade / controladoria",
  auditor: "Auditoria e compliance",
  external_counsel: "Escritório externo",
});
export const ROLE_DESCRIPTIONS = labels(ROLES, {
  admin: "Acesso total, inclusive usuários, parâmetros e integrações.",
  legal_manager: "Gestão do jurídico: vê toda a carteira (inclusive sigilosos), aprova valores e distribui demandas.",
  lawyer: "Jurídico interno: carteira da sua unidade e os casos sob sua responsabilidade.",
  analyst: "Apoio jurídico: cadastra entradas, documentos, prazos e tarefas da sua unidade.",
  executive: "Diretoria: consulta painéis e relatórios da carteira não sigilosa, sem editar.",
  accountant: "Contabilidade: valores, garantias, risco, provisão e fechamento mensal (sem peças sigilosas).",
  auditor: "Auditoria: leitura da carteira não sigilosa, relatórios e trilha de auditoria.",
  external_counsel: "Escritório externo: somente os processos atribuídos ao seu escritório.",
});

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const RISK_LEVEL_LABELS = labels(RISK_LEVELS, {
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
  critical: "Crítico",
});

/** Loss probability classification commonly used for legal provisions (remota/possível/provável). */
export const LOSS_PROBABILITIES = ["remote", "possible", "probable"] as const;
export type LossProbability = (typeof LOSS_PROBABILITIES)[number];
export const LOSS_PROBABILITY_LABELS = labels(LOSS_PROBABILITIES, {
  remote: "Remota",
  possible: "Possível",
  probable: "Provável",
});

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS = labels(PRIORITIES, {
  low: "Baixa",
  medium: "Média",
  high: "Alta",
  urgent: "Urgente",
});

/**
 * Where a piece of data came from. The UI must visually separate these:
 * manual = typed by a user; imported = loaded from a file/integration;
 * ai_suggested = produced by an AI analysis and not yet confirmed by a human.
 */
export const DATA_ORIGINS = ["manual", "imported", "ai_suggested", "system"] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];
export const DATA_ORIGIN_LABELS = labels(DATA_ORIGINS, {
  manual: "Cadastro manual",
  imported: "Importado",
  ai_suggested: "Sugerido pela IA",
  system: "Gerado pelo sistema",
});

/** Entities that documents, tasks, deadlines, comments, analyses and alerts can be attached to. */
export const ENTITY_TYPES = [
  "legal_process",
  "occurrence",
  "contract",
  "document",
  "task",
  "deadline",
  "analysis",
  "user",
  "team",
  "unit",
  "organization",
  "company",
  "law_firm",
  "hearing",
  "settlement",
  "valuation",
  "guarantee",
  "risk_assessment",
  "case_brief",
  "intake",
  "email",
  "import_batch",
  "snapshot",
  "distribution_rule",
  "api_key",
  "legal_report",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const ENTITY_TYPE_LABELS = labels(ENTITY_TYPES, {
  legal_process: "Processo",
  occurrence: "Ocorrência",
  contract: "Contrato",
  document: "Documento",
  task: "Tarefa",
  deadline: "Prazo",
  analysis: "Análise de IA",
  user: "Usuário",
  team: "Equipe",
  unit: "Unidade",
  organization: "Organização",
  company: "Empresa",
  law_firm: "Escritório externo",
  hearing: "Audiência",
  settlement: "Acordo",
  valuation: "Valoração",
  guarantee: "Garantia",
  risk_assessment: "Classificação de risco",
  case_brief: "Análise preliminar",
  intake: "Entrada de processo",
  email: "E-mail (simulado)",
  import_batch: "Importação de planilha",
  snapshot: "Fechamento mensal",
  distribution_rule: "Regra de distribuição",
  api_key: "Chave de API",
  legal_report: "Relatório jurídico",
});

// ---------------------------------------------------------------------------
// Legal processes (contencioso)
// ---------------------------------------------------------------------------

export const LEGAL_AREAS = [
  "labor",
  "civil",
  "consumer",
  "tax",
  "administrative",
  "environmental",
  "corporate",
  "criminal",
  "regulatory",
  "other",
] as const;
export type LegalArea = (typeof LEGAL_AREAS)[number];
export const LEGAL_AREA_LABELS = labels(LEGAL_AREAS, {
  labor: "Trabalhista",
  civil: "Cível",
  consumer: "Consumidor",
  tax: "Tributário",
  administrative: "Administrativo",
  environmental: "Ambiental",
  corporate: "Societário",
  criminal: "Penal",
  regulatory: "Regulatório",
  other: "Outra",
});

/**
 * Fase processual: eixo PRÓPRIO, distinto da instância (P0.5). Só três fases:
 * conhecimento, liquidação e execução. Recurso não é fase (é a instância em que
 * o processo tramita: 2º ou 3º grau); acordo e encerramento também não (acordo
 * é registro próprio; encerramento é a situação `closed` com motivo).
 */
export const PROCESS_PHASES = ["knowledge", "liquidation", "enforcement"] as const;
export type ProcessPhase = (typeof PROCESS_PHASES)[number];
export const PROCESS_PHASE_LABELS = labels(PROCESS_PHASES, {
  knowledge: "Conhecimento",
  liquidation: "Liquidação",
  enforcement: "Execução",
});

/**
 * Fases do modelo anterior (antes da separação entre fase e instância).
 * SOMENTE para exibir registros históricos que não podem mudar: itens de
 * competência fechada (RN-10), trilha de auditoria e a fase anterior guardada
 * pela migração (`legacy_phase`). Nunca oferecidas em formulários, filtros ou
 * gravações novas.
 */
export const LEGACY_PROCESS_PHASES = ["pre_filing", "appeal", "settlement", "closed"] as const;
export type LegacyProcessPhase = (typeof LEGACY_PROCESS_PHASES)[number];
export const LEGACY_PROCESS_PHASE_LABELS = labels(LEGACY_PROCESS_PHASES, {
  pre_filing: "Pré-ajuizamento",
  appeal: "Recursal",
  settlement: "Acordo em andamento",
  closed: "Encerrado",
});

/** Fase como pode estar gravada em registros históricos (atual ou do modelo anterior). */
export type StoredProcessPhase = ProcessPhase | LegacyProcessPhase;

/** Rótulos para EXIBIR uma fase gravada (atual ou histórica). Não use para montar opções. */
export const PROCESS_PHASE_DISPLAY_LABELS: Readonly<Record<StoredProcessPhase, string>> = {
  ...PROCESS_PHASE_LABELS,
  ...LEGACY_PROCESS_PHASE_LABELS,
};

/** Rótulo pt-BR de uma fase gravada (atual ou histórica); código desconhecido é devolvido como está. */
export function processPhaseLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return (PROCESS_PHASE_DISPLAY_LABELS as Record<string, string>)[code] ?? code;
}

export function isProcessPhase(value: unknown): value is ProcessPhase {
  return typeof value === "string" && (PROCESS_PHASES as readonly string[]).includes(value);
}

/** Grau / instância em que o processo (ou um vínculo de instância) tramita. Eixo distinto da fase. */
export const PROCESS_INSTANCES = ["first", "second", "superior"] as const;
export type ProcessInstance = (typeof PROCESS_INSTANCES)[number];
export const PROCESS_INSTANCE_LABELS = labels(PROCESS_INSTANCES, {
  first: "1º grau",
  second: "2º grau",
  superior: "3º grau",
});

/** Ordem dos graus (1º < 2º < 3º), para comparar instâncias. */
export const PROCESS_INSTANCE_RANK: Readonly<Record<ProcessInstance, number>> = { first: 1, second: 2, superior: 3 };

/** Motivo de saída da carteira ativa (RF-06 / RN-12). */
export const CLOSURE_REASONS = [
  "paid_extinct",
  "settlement_fulfilled",
  "dismissed",
  "archived",
  "returned_to_origin",
  "lost_patronage",
  "other",
] as const;
export type ClosureReason = (typeof CLOSURE_REASONS)[number];
export const CLOSURE_REASON_LABELS = labels(CLOSURE_REASONS, {
  paid_extinct: "Pago / extinto pela satisfação",
  settlement_fulfilled: "Acordo cumprido",
  dismissed: "Improcedente / extinto sem ônus",
  archived: "Arquivado definitivamente",
  returned_to_origin: "Baixado à origem",
  lost_patronage: "Saída do acervo / perda do patrocínio",
  other: "Outro motivo",
});

export const PROCESS_STATUSES = ["active", "suspended", "archived", "closed"] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];
export const PROCESS_STATUS_LABELS = labels(PROCESS_STATUSES, {
  active: "Ativo",
  suspended: "Suspenso",
  archived: "Arquivado",
  closed: "Encerrado",
});

export const PARTY_ROLES = ["plaintiff", "defendant", "third_party", "public_prosecutor", "other"] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];
export const PARTY_ROLE_LABELS = labels(PARTY_ROLES, {
  plaintiff: "Polo ativo",
  defendant: "Polo passivo",
  third_party: "Terceiro interessado",
  public_prosecutor: "Ministério Público",
  other: "Outro",
});

/** Natureza da responsabilidade da parte ré (análise jurídica, opcional). */
export const LIABILITY_NATURES = ["direct", "joint", "subsidiary"] as const;
export type LiabilityNature = (typeof LIABILITY_NATURES)[number];
export const LIABILITY_NATURE_LABELS = labels(LIABILITY_NATURES, {
  direct: "Direta",
  joint: "Solidária",
  subsidiary: "Subsidiária",
});

export const PROCESS_EVENT_TYPES = [
  "filing",
  "hearing",
  "decision",
  "petition",
  "publication",
  "settlement",
  "note",
  "other",
] as const;
export type ProcessEventType = (typeof PROCESS_EVENT_TYPES)[number];
export const PROCESS_EVENT_TYPE_LABELS = labels(PROCESS_EVENT_TYPES, {
  filing: "Distribuição",
  hearing: "Audiência",
  decision: "Decisão / sentença",
  petition: "Petição",
  publication: "Publicação / intimação",
  settlement: "Acordo",
  note: "Anotação interna",
  other: "Outro",
});

// ---------------------------------------------------------------------------
// Preventive (ocorrências)
// ---------------------------------------------------------------------------

export const OCCURRENCE_STATUSES = [
  "open",
  "under_analysis",
  "action_plan",
  "monitoring",
  "resolved",
  "converted_to_process",
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];
export const OCCURRENCE_STATUS_LABELS = labels(OCCURRENCE_STATUSES, {
  open: "Aberta",
  under_analysis: "Em análise",
  action_plan: "Plano de ação",
  monitoring: "Em monitoramento",
  resolved: "Resolvida",
  converted_to_process: "Convertida em processo",
});

export const OCCURRENCE_CATEGORIES = [
  "labor",
  "consumer_complaint",
  "contractual",
  "regulatory",
  "environmental",
  "data_privacy",
  "corporate",
  "tax",
  "other",
] as const;
export type OccurrenceCategory = (typeof OCCURRENCE_CATEGORIES)[number];
export const OCCURRENCE_CATEGORY_LABELS = labels(OCCURRENCE_CATEGORIES, {
  labor: "Trabalhista",
  consumer_complaint: "Reclamação de consumidor",
  contractual: "Contratual",
  regulatory: "Regulatória",
  environmental: "Ambiental",
  data_privacy: "Privacidade e dados pessoais",
  corporate: "Societária",
  tax: "Tributária",
  other: "Outra",
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export const CONTRACT_STATUSES = ["draft", "under_review", "active", "expired", "terminated"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const CONTRACT_STATUS_LABELS = labels(CONTRACT_STATUSES, {
  draft: "Minuta",
  under_review: "Em revisão",
  active: "Vigente",
  expired: "Expirado",
  terminated: "Rescindido",
});

export const CONTRACT_TYPES = [
  "services",
  "supply",
  "lease",
  "nda",
  "partnership",
  "employment",
  "software_license",
  "other",
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const CONTRACT_TYPE_LABELS = labels(CONTRACT_TYPES, {
  services: "Prestação de serviços",
  supply: "Fornecimento",
  lease: "Locação",
  nda: "Confidencialidade (NDA)",
  partnership: "Parceria",
  employment: "Trabalho",
  software_license: "Licença de software",
  other: "Outro",
});

export const RENEWAL_TYPES = ["automatic", "manual", "none"] as const;
export type RenewalType = (typeof RENEWAL_TYPES)[number];
export const RENEWAL_TYPE_LABELS = labels(RENEWAL_TYPES, {
  automatic: "Renovação automática",
  manual: "Renovação mediante aditivo",
  none: "Sem renovação",
});

export const OBLIGATION_STATUSES = ["pending", "fulfilled", "overdue", "waived"] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];
export const OBLIGATION_STATUS_LABELS = labels(OBLIGATION_STATUSES, {
  pending: "Pendente",
  fulfilled: "Cumprida",
  overdue: "Em atraso",
  waived: "Dispensada",
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DOCUMENT_CATEGORIES = [
  "contract",
  "amendment",
  "petition",
  "decision",
  "evidence",
  "correspondence",
  "report",
  "internal",
  "other",
  "initial_petition",
  "defense",
  "calculation",
  "judgment",
  "appellate_decision",
  "hearing_minutes",
  "release_order",
  "settlement_term",
  "power_of_attorney",
  "sensitive_health",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
export const DOCUMENT_CATEGORY_LABELS = labels(DOCUMENT_CATEGORIES, {
  contract: "Contrato",
  amendment: "Aditivo",
  petition: "Petição",
  decision: "Decisão",
  evidence: "Prova / evidência",
  correspondence: "Correspondência",
  report: "Relatório / parecer",
  internal: "Documento interno",
  other: "Outro",
  initial_petition: "Petição inicial",
  defense: "Contestação / defesa",
  calculation: "Planilha de cálculos",
  judgment: "Sentença",
  appellate_decision: "Acórdão",
  hearing_minutes: "Ata de audiência",
  release_order: "Alvará",
  settlement_term: "Termo de acordo",
  power_of_attorney: "Procuração / substabelecimento",
  sensitive_health: "Atestado, laudo ou CAT (dado sensível)",
});

export const CONFIDENTIALITY_LEVELS = ["internal", "confidential", "restricted"] as const;
export type ConfidentialityLevel = (typeof CONFIDENTIALITY_LEVELS)[number];
export const CONFIDENTIALITY_LABELS = labels(CONFIDENTIALITY_LEVELS, {
  internal: "Interno",
  confidential: "Confidencial",
  restricted: "Restrito",
});

export const TEXT_EXTRACTION_STATUSES = ["pending", "succeeded", "failed", "unsupported"] as const;
export type TextExtractionStatus = (typeof TEXT_EXTRACTION_STATUSES)[number];
export const TEXT_EXTRACTION_STATUS_LABELS = labels(TEXT_EXTRACTION_STATUSES, {
  pending: "Extração pendente",
  succeeded: "Texto extraído",
  failed: "Falha na extração",
  unsupported: "Formato sem extração de texto",
});

// ---------------------------------------------------------------------------
// Deadlines & tasks
// ---------------------------------------------------------------------------

export const DEADLINE_KINDS = ["procedural", "contractual", "regulatory", "internal"] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];
export const DEADLINE_KIND_LABELS = labels(DEADLINE_KINDS, {
  procedural: "Processual",
  contractual: "Contratual",
  regulatory: "Regulatório",
  internal: "Interno",
});

export const DEADLINE_STATUSES = ["open", "done", "cancelled"] as const;
export type DeadlineStatus = (typeof DEADLINE_STATUSES)[number];
export const DEADLINE_STATUS_LABELS = labels(DEADLINE_STATUSES, {
  open: "Em aberto",
  done: "Cumprido",
  cancelled: "Cancelado",
});

/**
 * AI-suggested deadlines start as `pending_validation` and must be validated by
 * a user with `deadline:validate` before they count as a real deadline.
 */
export const VALIDATION_STATUSES = ["not_required", "pending_validation", "validated", "rejected"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];
export const VALIDATION_STATUS_LABELS = labels(VALIDATION_STATUSES, {
  not_required: "Cadastro manual",
  pending_validation: "Aguardando validação humana",
  validated: "Validado",
  rejected: "Rejeitado",
});

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS = labels(TASK_STATUSES, {
  todo: "A fazer",
  in_progress: "Em andamento",
  blocked: "Bloqueada",
  done: "Concluída",
  cancelled: "Cancelada",
});

/** `action_plan` tasks are the action plan items of an occurrence. */
export const TASK_KINDS = ["general", "action_plan", "review", "follow_up"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const TASK_KIND_LABELS = labels(TASK_KINDS, {
  general: "Geral",
  action_plan: "Plano de ação",
  review: "Revisão",
  follow_up: "Acompanhamento",
});

// ---------------------------------------------------------------------------
// AI analyses
// ---------------------------------------------------------------------------

export const ANALYSIS_TYPES = [
  "summary",
  "extraction",
  "risk_signals",
  "inconsistencies",
  "preventive_actions",
  "question_answer",
] as const;
export type AnalysisType = (typeof ANALYSIS_TYPES)[number];
export const ANALYSIS_TYPE_LABELS = labels(ANALYSIS_TYPES, {
  summary: "Resumo",
  extraction: "Extração de informações",
  risk_signals: "Sinais de risco e informações faltantes",
  inconsistencies: "Contradições, documentos faltantes e obrigações pendentes",
  preventive_actions: "Sugestão de ações preventivas",
  question_answer: "Pergunta e resposta",
});

export const ANALYSIS_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];
export const ANALYSIS_STATUS_LABELS = labels(ANALYSIS_STATUSES, {
  queued: "Na fila",
  running: "Em processamento",
  succeeded: "Concluída",
  failed: "Falhou",
  cancelled: "Cancelada",
});

export const ANALYSIS_REVIEW_STATUSES = ["pending_review", "reviewed", "dismissed"] as const;
export type AnalysisReviewStatus = (typeof ANALYSIS_REVIEW_STATUSES)[number];
export const ANALYSIS_REVIEW_STATUS_LABELS = labels(ANALYSIS_REVIEW_STATUSES, {
  pending_review: "Aguardando revisão",
  reviewed: "Revisada",
  dismissed: "Descartada",
});

/** `demo` analyses are produced by the deterministic demo provider and are NOT real AI analyses. */
export const AI_MODES = ["live", "demo"] as const;
export type AiMode = (typeof AI_MODES)[number];
export const AI_MODE_LABELS = labels(AI_MODES, {
  live: "Análise por IA",
  demo: "Modo demonstrativo (sem IA real)",
});

export const ANALYSIS_TRIGGERS = ["manual", "document_uploaded", "record_changed", "scheduled"] as const;
export type AnalysisTrigger = (typeof ANALYSIS_TRIGGERS)[number];
export const ANALYSIS_TRIGGER_LABELS = labels(ANALYSIS_TRIGGERS, {
  manual: "Solicitação manual",
  document_uploaded: "Novo documento",
  record_changed: "Alteração relevante",
  scheduled: "Rotina agendada",
});

/** Entities an analysis can be about. */
export const ANALYSIS_SUBJECT_TYPES = ["legal_process", "occurrence", "contract", "document", "organization"] as const;
export type AnalysisSubjectType = (typeof ANALYSIS_SUBJECT_TYPES)[number];

// ---------------------------------------------------------------------------
// Alerts, jobs & routines
// ---------------------------------------------------------------------------

export const ALERT_TYPES = [
  "deadline_upcoming",
  "deadline_overdue",
  "deadline_pending_validation",
  "contract_expiring",
  "obligation_due",
  "risk_signal",
  "analysis_stale",
  "analysis_failed",
  "hearing_upcoming",
  "settlement_installment_due",
  "valuation_pending_review",
  "enforcement_without_value",
  "guarantee_idle",
  "process_needs_verification",
  "brief_pending_review",
  "intake_unassigned",
  "new_process_received",
  "court_movement_relevant",
  "court_hearing_designated",
  "court_sync_failed",
  "claims_risk_review",
  "snapshot_close_blocked",
  "legal_report_outdated",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export const ALERT_TYPE_LABELS = labels(ALERT_TYPES, {
  deadline_upcoming: "Prazo próximo",
  deadline_overdue: "Prazo vencido",
  deadline_pending_validation: "Prazo aguardando validação",
  contract_expiring: "Contrato próximo do vencimento",
  obligation_due: "Obrigação contratual próxima",
  risk_signal: "Sinal de risco",
  analysis_stale: "Análise desatualizada",
  analysis_failed: "Falha em análise",
  hearing_upcoming: "Audiência próxima",
  settlement_installment_due: "Parcela de acordo a vencer",
  valuation_pending_review: "Valor aguardando conferência",
  enforcement_without_value: "Execução sem valor apurado",
  guarantee_idle: "Depósito / garantia parada",
  process_needs_verification: "Processo pendente de conferência",
  brief_pending_review: "Análise preliminar aguardando revisão",
  intake_unassigned: "Entrada sem responsável",
  new_process_received: "Novo processo recebido",
  court_movement_relevant: "Movimentação relevante no tribunal (DataJud)",
  court_hearing_designated: "Audiência designada no tribunal: cadastrar a data",
  court_sync_failed: "Falha na coleta de dados do tribunal (DataJud)",
  claims_risk_review: "Classificação de risco a rever (pedidos do processo)",
  snapshot_close_blocked: "Processo sem classificação de risco impede o fechamento mensal",
  legal_report_outdated: "Relatório do processo (R1) aprovado desatualizado: gerar nova versão",
});

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const ALERT_SEVERITY_LABELS = labels(ALERT_SEVERITIES, {
  info: "Informativo",
  warning: "Atenção",
  critical: "Crítico",
});

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = [
  "analysis.run",
  "document.extract_text",
  "routine.run",
  "intake.process",
  "case_brief.generate",
  "court_sync.run",
  "bi.refresh",
  "import.distribute",
  "legal_report.generate",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const ROUTINE_TYPES = [
  "deadline_alerts",
  "contract_expiration_alerts",
  "stale_analysis_refresh",
  "retention_review",
  "hearing_alerts",
  "portfolio_alerts",
  "monthly_snapshot",
  "court_sync",
  "simulated_feed",
  "bi_access_refresh",
  "index_series_refresh",
  "legal_reports_refresh",
] as const;
export type RoutineType = (typeof ROUTINE_TYPES)[number];
export const ROUTINE_TYPE_LABELS = labels(ROUTINE_TYPES, {
  deadline_alerts: "Alertas de prazos",
  contract_expiration_alerts: "Alertas de vigência contratual",
  stale_analysis_refresh: "Reanálise de análises desatualizadas",
  retention_review: "Revisão de retenção de dados",
  hearing_alerts: "Alertas de audiências",
  portfolio_alerts: "Pendências da carteira (acordos, valores, garantias, conferência de cadastros)",
  monthly_snapshot: "Fechamento mensal da carteira (prévia)",
  court_sync: "Acompanhamento da carteira no DataJud (CNJ)",
  simulated_feed: "Chegada automática simulada de processos (demonstração)",
  bi_access_refresh: "Acessos e atualização dos painéis Power BI",
  index_series_refresh: "Atualização das séries de índices de correção (Banco Central)",
  legal_reports_refresh: "Atualização dos relatórios do processo (R1) com dados novos",
});

// ---------------------------------------------------------------------------
// Contingências: valoração, garantias, risco, acordos, fechamento mensal
// ---------------------------------------------------------------------------

/**
 * Tipos de valoração (RF-07/RF-09). Valores de tipos diferentes NUNCA se somam
 * (RN-02): valor da causa é exposição declarada; liquidado é dívida apurada.
 */
export const VALUATION_KINDS = ["claim", "liquidated", "settlement", "deposit", "paid", "fees", "estimate"] as const;
export type ValuationKind = (typeof VALUATION_KINDS)[number];
export const VALUATION_KIND_LABELS = labels(VALUATION_KINDS, {
  claim: "Valor da causa",
  liquidated: "Valor liquidado / apurado",
  settlement: "Valor de acordo",
  deposit: "Depósito",
  paid: "Valor pago",
  fees: "Honorários",
  estimate: "Estimativa (não apurada)",
});

/**
 * Valores importados, extraídos de documento ou sugeridos ficam `proposed` até
 * conferência humana identificada (RN-11); `official` exige `reviewedById`.
 * Valores nunca são sobrescritos: nova apuração = novo registro (RF-09).
 */
export const VALUATION_STATUSES = ["proposed", "official", "rejected", "superseded"] as const;
export type ValuationStatus = (typeof VALUATION_STATUSES)[number];
export const VALUATION_STATUS_LABELS = labels(VALUATION_STATUSES, {
  proposed: "Proposto, aguardando conferência",
  official: "Oficial",
  rejected: "Rejeitado",
  superseded: "Substituído por valor mais recente",
});

/** Where a valuation came from. Used for source prevalence (RN-08): document > official system > manual. */
export const VALUATION_SOURCES = ["document", "official_system", "spreadsheet", "manual", "simulation"] as const;
export type ValuationSource = (typeof VALUATION_SOURCES)[number];
export const VALUATION_SOURCE_LABELS = labels(VALUATION_SOURCES, {
  document: "Peça dos autos",
  official_system: "Sistema oficial do tribunal",
  spreadsheet: "Planilha importada",
  manual: "Lançamento manual",
  simulation: "Extração simulada (demonstração)",
});

export const GUARANTEE_KINDS = [
  "judicial_deposit",
  "appeal_deposit",
  "seizure",
  "surety_insurance",
  "bank_guarantee",
  "other",
] as const;
export type GuaranteeKind = (typeof GUARANTEE_KINDS)[number];
export const GUARANTEE_KIND_LABELS = labels(GUARANTEE_KINDS, {
  judicial_deposit: "Depósito judicial",
  appeal_deposit: "Depósito recursal",
  seizure: "Penhora / bloqueio",
  surety_insurance: "Seguro garantia",
  bank_guarantee: "Carta de fiança",
  other: "Outra garantia",
});

/** Only `linked` guarantees reduce the net exposure (RN-04). */
export const GUARANTEE_STATUSES = ["linked", "released_to_plaintiff", "returned_to_company"] as const;
export type GuaranteeStatus = (typeof GUARANTEE_STATUSES)[number];
export const GUARANTEE_STATUS_LABELS = labels(GUARANTEE_STATUSES, {
  linked: "Vinculada ao processo",
  released_to_plaintiff: "Liberada ao autor",
  returned_to_company: "Devolvida à empresa",
});

export const SETTLEMENT_STATUSES = [
  "proposal",
  "negotiating",
  "signed",
  "homologated",
  "fulfilled",
  "breached",
  "cancelled",
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export const SETTLEMENT_STATUS_LABELS = labels(SETTLEMENT_STATUSES, {
  proposal: "Proposta",
  negotiating: "Em negociação",
  signed: "Firmado",
  homologated: "Homologado",
  fulfilled: "Cumprido",
  breached: "Descumprido",
  cancelled: "Recusado / cancelado",
});

export const INSTALLMENT_STATUSES = ["pending", "paid", "cancelled"] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];
export const INSTALLMENT_STATUS_LABELS = labels(INSTALLMENT_STATUSES, {
  pending: "A pagar",
  paid: "Paga",
  cancelled: "Cancelada",
});

export const SNAPSHOT_STATUSES = ["preview", "closed"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];
export const SNAPSHOT_STATUS_LABELS = labels(SNAPSHOT_STATUSES, {
  preview: "Prévia (recalculável)",
  closed: "Competência fechada (imutável)",
});

// ---------------------------------------------------------------------------
// Audiências
// ---------------------------------------------------------------------------

export const HEARING_KINDS = ["initial", "conciliation", "instruction", "unified", "judgment_session", "other"] as const;
export type HearingKind = (typeof HEARING_KINDS)[number];
export const HEARING_KIND_LABELS = labels(HEARING_KINDS, {
  initial: "Audiência inicial",
  conciliation: "Conciliação",
  instruction: "Instrução",
  unified: "Audiência una",
  judgment_session: "Sessão de julgamento / pauta",
  other: "Outra",
});

export const HEARING_MODES = ["in_person", "virtual", "hybrid"] as const;
export type HearingMode = (typeof HEARING_MODES)[number];
export const HEARING_MODE_LABELS = labels(HEARING_MODES, {
  in_person: "Presencial",
  virtual: "Telepresencial",
  hybrid: "Híbrida",
});

export const HEARING_STATUSES = ["scheduled", "held", "rescheduled", "cancelled"] as const;
export type HearingStatus = (typeof HEARING_STATUSES)[number];
export const HEARING_STATUS_LABELS = labels(HEARING_STATUSES, {
  scheduled: "Designada",
  held: "Realizada",
  rescheduled: "Redesignada",
  cancelled: "Cancelada",
});

// ---------------------------------------------------------------------------
// Entrada de processos, distribuição e análise preliminar
// ---------------------------------------------------------------------------

export const INTAKE_SOURCES = ["manual", "import", "simulated_feed", "api"] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];
export const INTAKE_SOURCE_LABELS = labels(INTAKE_SOURCES, {
  manual: "Cadastro manual",
  import: "Importação de planilha",
  simulated_feed: "Chegada simulada (demonstração)",
  api: "Recebido por API (sistema externo)",
});

export const INTAKE_STATUSES = [
  "received",
  "assigned",
  "analyzing",
  "brief_ready",
  "notified",
  "in_review",
  "approved",
  "failed",
  "cancelled",
] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];
export const INTAKE_STATUS_LABELS = labels(INTAKE_STATUSES, {
  received: "Recebido",
  assigned: "Responsável definido",
  analyzing: "Lendo documentos (simulação)",
  brief_ready: "Análise preliminar pronta",
  notified: "Advogado notificado (e-mail simulado)",
  in_review: "Em revisão pelo advogado",
  approved: "Análise aprovada",
  failed: "Falha no processamento",
  cancelled: "Cancelado",
});

export const ASSIGNMENT_METHODS = ["rule", "least_loaded", "round_robin", "manual", "kept"] as const;
export type AssignmentMethod = (typeof ASSIGNMENT_METHODS)[number];
export const ASSIGNMENT_METHOD_LABELS = labels(ASSIGNMENT_METHODS, {
  rule: "Regra de distribuição",
  least_loaded: "Menor carga de trabalho",
  round_robin: "Rodízio da equipe",
  manual: "Atribuição manual",
  kept: "Responsável já cadastrado",
});

export const CASE_BRIEF_STATUSES = ["generating", "ready_for_review", "in_review", "approved", "rejected", "failed"] as const;
export type CaseBriefStatus = (typeof CASE_BRIEF_STATUSES)[number];
export const CASE_BRIEF_STATUS_LABELS = labels(CASE_BRIEF_STATUSES, {
  generating: "Em processamento",
  ready_for_review: "Pronta para revisão",
  in_review: "Em revisão (editada)",
  approved: "Aprovada pelo advogado",
  rejected: "Rejeitada",
  failed: "Falhou",
});

// ---------------------------------------------------------------------------
// E-mail (simulado nesta etapa)
// ---------------------------------------------------------------------------

/** `simulated`: rendered and stored, never delivered. `live` is reserved for a future real provider. */
export const EMAIL_MODES = ["simulated", "live"] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];
export const EMAIL_MODE_LABELS = labels(EMAIL_MODES, {
  simulated: "Envio simulado: nenhuma mensagem real é enviada",
  live: "Envio real",
});

export const EMAIL_TEMPLATES = [
  "case_brief_ready",
  "intake_assigned",
  "deadline_reminder",
  "hearing_reminder",
  "daily_digest",
  "brief_approved",
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];
export const EMAIL_TEMPLATE_LABELS = labels(EMAIL_TEMPLATES, {
  case_brief_ready: "Análise preliminar disponível",
  intake_assigned: "Novo processo atribuído",
  deadline_reminder: "Lembrete de prazo",
  hearing_reminder: "Lembrete de audiência",
  daily_digest: "Resumo diário de pendências",
  brief_approved: "Análise preliminar aprovada",
});

export const EMAIL_STATUSES = ["simulated", "failed", "cancelled"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];
export const EMAIL_STATUS_LABELS = labels(EMAIL_STATUSES, {
  simulated: "Envio simulado registrado",
  failed: "Falha ao gerar",
  cancelled: "Cancelado",
});

// ---------------------------------------------------------------------------
// Importação de planilhas
// ---------------------------------------------------------------------------

export const IMPORT_BATCH_STATUSES = ["analyzed", "committed", "rolled_back", "failed"] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];
export const IMPORT_BATCH_STATUS_LABELS = labels(IMPORT_BATCH_STATUSES, {
  analyzed: "Analisada, aguardando confirmação",
  committed: "Importada",
  rolled_back: "Desfeita",
  failed: "Falhou",
});

export const IMPORT_ROW_ACTIONS = ["create", "update", "unchanged", "merge_instance", "skip", "error"] as const;
export type ImportRowAction = (typeof IMPORT_ROW_ACTIONS)[number];
export const IMPORT_ROW_ACTION_LABELS = labels(IMPORT_ROW_ACTIONS, {
  create: "Novo processo",
  update: "Atualiza processo existente",
  unchanged: "Sem alterações",
  merge_instance: "Vínculo de instância (mesmo CNJ)",
  skip: "Ignorada",
  error: "Com erro (não importada)",
});

export const ISSUE_LEVELS = ["error", "warning", "info"] as const;
export type IssueLevel = (typeof ISSUE_LEVELS)[number];
export const ISSUE_LEVEL_LABELS = labels(ISSUE_LEVELS, {
  error: "Erro",
  warning: "Alerta",
  info: "Informação",
});

// ---------------------------------------------------------------------------
// Coleta automática nos tribunais (DataJud) e API de entrada
// ---------------------------------------------------------------------------

/** State of a process in the court data collection (DataJud). */
export const COURT_SYNC_STATUSES = ["pending", "found", "not_found", "error", "unsupported"] as const;
export type CourtSyncStatus = (typeof COURT_SYNC_STATUSES)[number];
export const COURT_SYNC_STATUS_LABELS = labels(COURT_SYNC_STATUSES, {
  pending: "Aguardando a primeira consulta",
  found: "Encontrado no DataJud",
  not_found: "Não encontrado no DataJud",
  error: "Falha na consulta",
  unsupported: "Sem consulta: número inválido (dígito verificador), fora do padrão CNJ ou tribunal sem endpoint",
});

export const COURT_SYNC_RUN_STATUSES = ["running", "succeeded", "partial", "failed"] as const;
export type CourtSyncRunStatus = (typeof COURT_SYNC_RUN_STATUSES)[number];
export const COURT_SYNC_RUN_STATUS_LABELS = labels(COURT_SYNC_RUN_STATUSES, {
  running: "Em execução",
  succeeded: "Concluída",
  partial: "Concluída com falhas",
  failed: "Falhou",
});

export const COURT_SYNC_TRIGGERS = ["routine", "manual", "intake", "api"] as const;
export type CourtSyncTrigger = (typeof COURT_SYNC_TRIGGERS)[number];
export const COURT_SYNC_TRIGGER_LABELS = labels(COURT_SYNC_TRIGGERS, {
  routine: "Rotina agendada",
  manual: "Solicitação manual",
  intake: "Entrada de processo",
  api: "Recebimento por API",
});

/** Scopes an API key can hold (inbound API, /api/v1). */
export const API_KEY_SCOPES = ["intake:create", "process:read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const API_KEY_SCOPE_LABELS = labels(API_KEY_SCOPES, {
  "intake:create": "Enviar processos novos (entrada automática)",
  "process:read": "Consultar a situação dos processos enviados",
});

export const INBOUND_REQUEST_STATUSES = [
  "processing",
  "accepted",
  "updated_existing",
  "duplicate",
  "consulted",
  "rejected",
  "failed",
] as const;
export type InboundRequestStatus = (typeof INBOUND_REQUEST_STATUSES)[number];
export const INBOUND_REQUEST_STATUS_LABELS = labels(INBOUND_REQUEST_STATUSES, {
  processing: "Em processamento",
  accepted: "Aceito: entrada criada",
  updated_existing: "Processo já existia: documentos anexados",
  duplicate: "Repetição respondida com o resultado anterior (mesma chave de idempotência)",
  consulted: "Consulta de situação respondida",
  rejected: "Rejeitado (dados inválidos ou sem permissão)",
  failed: "Falha interna",
});

// ---------------------------------------------------------------------------
// Painéis Power BI (camada governada "bi" e atualização automática)
// ---------------------------------------------------------------------------

/** O que disparou uma atualização do conjunto de dados no Power BI. */
export const BI_REFRESH_TRIGGERS = ["schedule", "import_batch", "snapshot_closed", "court_sync", "access_change", "manual"] as const;
export type BiRefreshTrigger = (typeof BI_REFRESH_TRIGGERS)[number];
export const BI_REFRESH_TRIGGER_LABELS = labels(BI_REFRESH_TRIGGERS, {
  schedule: "Agenda periódica",
  import_batch: "Importação de planilha confirmada ou desfeita",
  snapshot_closed: "Competência mensal fechada",
  court_sync: "Coleta nos tribunais com novidades",
  access_change: "Mudança nos acessos (processo, sigilo, unidade ou papel)",
  manual: "Solicitação manual",
});

/** Situação de uma solicitação de atualização ao Power BI. */
export const BI_REFRESH_STATUSES = ["requested", "succeeded", "failed", "skipped"] as const;
export type BiRefreshStatus = (typeof BI_REFRESH_STATUSES)[number];
export const BI_REFRESH_STATUS_LABELS = labels(BI_REFRESH_STATUSES, {
  requested: "Solicitada ao Power BI",
  succeeded: "Concluída no Power BI",
  failed: "Falhou",
  skipped: "Não executada",
});

// ---------------------------------------------------------------------------
// Pedidos do processo (verbas pleiteadas) e risco por pedido
// ---------------------------------------------------------------------------

/** Categoria do pedido: lista local de apoio à leitura, sem nenhuma regra jurídica associada. */
export const CLAIM_CATEGORIES = [
  "overtime",
  "severance_pay",
  "fgts",
  "moral_damages",
  "material_damages",
  "health_hazard_pay",
  "salary_equalization",
  "other",
] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];
export const CLAIM_CATEGORY_LABELS = labels(CLAIM_CATEGORIES, {
  overtime: "Horas extras",
  severance_pay: "Verbas rescisórias",
  fgts: "FGTS",
  moral_damages: "Dano moral",
  material_damages: "Dano material",
  health_hazard_pay: "Insalubridade / periculosidade",
  salary_equalization: "Equiparação salarial",
  other: "Outros",
});

/** De onde veio o pedido (subconjunto de DATA_ORIGINS). */
export const CLAIM_ORIGINS = ["manual", "imported", "ai_suggested"] as const;
export type ClaimOrigin = (typeof CLAIM_ORIGINS)[number];
export const CLAIM_ORIGIN_LABELS = labels(CLAIM_ORIGINS, {
  manual: "Cadastro manual",
  imported: "Importado",
  ai_suggested: "Sugerido pela análise preliminar",
});

/** Pedidos sugeridos pela análise preliminar só contam no risco depois de confirmados por uma pessoa. */
export const CLAIM_STATUSES = ["pending_confirmation", "confirmed", "dismissed"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_STATUS_LABELS = labels(CLAIM_STATUSES, {
  pending_confirmation: "Aguardando confirmação",
  confirmed: "Confirmado",
  dismissed: "Descartado",
});

/** Registro de risco do processo ligado aos pedidos: derivado (automático) ou definido manualmente com justificativa. */
export const CLAIM_RISK_LINK_KINDS = ["derived", "override"] as const;
export type ClaimRiskLinkKind = (typeof CLAIM_RISK_LINK_KINDS)[number];
export const CLAIM_RISK_LINK_KIND_LABELS = labels(CLAIM_RISK_LINK_KINDS, {
  derived: "Derivada dos pedidos",
  override: "Definida manualmente (diferente da derivada)",
});

// ---------------------------------------------------------------------------
// Relatórios jurídicos (PDF com origem declarada por item)
// ---------------------------------------------------------------------------

export const LEGAL_REPORT_TYPES = ["process_report", "provision_report", "portfolio_report", "responsibility_report"] as const;
export type LegalReportType = (typeof LEGAL_REPORT_TYPES)[number];
export const LEGAL_REPORT_TYPE_LABELS = labels(LEGAL_REPORT_TYPES, {
  process_report: "Relatório do processo (R1)",
  provision_report: "Relatório de provisão (R2)",
  portfolio_report: "Relatório da carteira (R3)",
  responsibility_report: "Relatório por responsável (R4)",
});
/** Prefixo da referência sequencial por tipo e ano (ex.: R1-2026-0007). */
export const LEGAL_REPORT_TYPE_CODES = labels(LEGAL_REPORT_TYPES, {
  process_report: "R1",
  provision_report: "R2",
  portfolio_report: "R3",
  responsibility_report: "R4",
});

export const LEGAL_REPORT_STATUSES = ["draft", "pending_review", "approved", "superseded"] as const;
export type LegalReportStatus = (typeof LEGAL_REPORT_STATUSES)[number];
export const LEGAL_REPORT_STATUS_LABELS = labels(LEGAL_REPORT_STATUSES, {
  draft: "Rascunho",
  pending_review: "Pendente de revisão",
  approved: "Aprovado",
  superseded: "Substituído por nova versão",
});

/** Origem obrigatória de cada item de relatório (selo no PDF). */
export const REPORT_ITEM_ORIGINS = ["documented", "record", "inference", "analysis", "gap"] as const;
export type ReportItemOrigin = (typeof REPORT_ITEM_ORIGINS)[number];
export const REPORT_ITEM_ORIGIN_LABELS = labels(REPORT_ITEM_ORIGINS, {
  documented: "Documentado",
  record: "Cadastro",
  inference: "Inferência",
  analysis: "Análise",
  gap: "Lacuna",
});
export const REPORT_ITEM_ORIGIN_DESCRIPTIONS = labels(REPORT_ITEM_ORIGINS, {
  documented: "Trecho literal de documento, com página, conferido automaticamente.",
  record: "Dado do cadastro do sistema, com tabela, campo e data do registro.",
  inference: "Conclusão calculada a partir de outros itens do relatório.",
  analysis: "Análise registrada (parecer, análise preliminar ou de IA).",
  gap: "Dado não localizado na base: nunca é tratado como zero.",
});

/** Faixas de probabilidade dos cenários (percentuais editáveis nas configurações). */
export const PROBABILITY_BANDS = ["very_high", "high", "moderate", "low", "very_low"] as const;
export type ProbabilityBand = (typeof PROBABILITY_BANDS)[number];
export const PROBABILITY_BAND_LABELS = labels(PROBABILITY_BANDS, {
  very_high: "Muito alta",
  high: "Alta",
  moderate: "Moderada",
  low: "Baixa",
  very_low: "Muito baixa",
});

export const SCENARIO_ORIGINS = ["system", "manual"] as const;
export type ScenarioOrigin = (typeof SCENARIO_ORIGINS)[number];
export const SCENARIO_ORIGIN_LABELS = labels(SCENARIO_ORIGINS, {
  system: "Gerado pelo sistema",
  manual: "Registrado manualmente",
});

// ---------------------------------------------------------------------------
// Índices de correção monetária (séries mensais do Banco Central, P1.7)
// ---------------------------------------------------------------------------

/**
 * Índice de atualização de uma valoração. `none` = escolha explícita de não
 * atualizar. Valorações anteriores ao recurso ficam com `null` ("sem índice
 * informado"). Qual índice vale para cada caso é escolha do advogado: o sistema
 * não aplica nenhuma regra sobre isso.
 */
export const CORRECTION_INDEXES = ["ipca_e", "ipca", "inpc", "selic", "tr", "none"] as const;
export type CorrectionIndex = (typeof CORRECTION_INDEXES)[number];
export const CORRECTION_INDEX_LABELS = labels(CORRECTION_INDEXES, {
  ipca_e: "IPCA-E",
  ipca: "IPCA",
  inpc: "INPC",
  selic: "Selic (acumulada no mês)",
  tr: "TR (primeiro dia do mês)",
  none: "Sem atualização",
});

/** Índices com série mensal coletada no Banco Central (todos menos `none`). */
export const INDEX_SERIES_CODES = ["ipca_e", "ipca", "inpc", "selic", "tr"] as const;
export type IndexSeriesCode = (typeof INDEX_SERIES_CODES)[number];
