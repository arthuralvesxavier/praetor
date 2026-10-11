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

export const ROLES = ["admin", "legal_manager", "lawyer", "analyst", "executive"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS = labels(ROLES, {
  admin: "Administrador",
  legal_manager: "Gestor jurídico",
  lawyer: "Advogado",
  analyst: "Analista",
  executive: "Executivo",
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

export const PROCESS_PHASES = [
  "pre_filing",
  "knowledge",
  "appeal",
  "enforcement",
  "settlement",
  "closed",
] as const;
export type ProcessPhase = (typeof PROCESS_PHASES)[number];
export const PROCESS_PHASE_LABELS = labels(PROCESS_PHASES, {
  pre_filing: "Pré-ajuizamento",
  knowledge: "Conhecimento",
  appeal: "Recursal",
  enforcement: "Execução / cumprimento",
  settlement: "Acordo em andamento",
  closed: "Encerrado",
});

export const PROCESS_STATUSES = ["active", "suspended", "archived", "closed"] as const;
export type ProcessStatus = (typeof PROCESS_STATUSES)[number];
export const PROCESS_STATUS_LABELS = labels(PROCESS_STATUSES, {
  active: "Ativo",
  suspended: "Suspenso",
  archived: "Arquivado",
  closed: "Encerrado",
});

export const PARTY_ROLES = ["plaintiff", "defendant", "third_party", "other"] as const;
export type PartyRole = (typeof PARTY_ROLES)[number];
export const PARTY_ROLE_LABELS = labels(PARTY_ROLES, {
  plaintiff: "Polo ativo",
  defendant: "Polo passivo",
  third_party: "Terceiro interessado",
  other: "Outro",
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
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const ROUTINE_TYPES = [
  "deadline_alerts",
  "contract_expiration_alerts",
  "stale_analysis_refresh",
  "retention_review",
] as const;
export type RoutineType = (typeof ROUTINE_TYPES)[number];
export const ROUTINE_TYPE_LABELS = labels(ROUTINE_TYPES, {
  deadline_alerts: "Alertas de prazos",
  contract_expiration_alerts: "Alertas de vigência contratual",
  stale_analysis_refresh: "Reanálise de análises desatualizadas",
  retention_review: "Revisão de retenção de dados",
});
