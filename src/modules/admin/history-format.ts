import {
  CONFIDENTIALITY_LABELS,
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  DATA_ORIGIN_LABELS,
  DEADLINE_KIND_LABELS,
  DEADLINE_STATUS_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  ENTITY_TYPE_LABELS,
  LEGAL_AREA_LABELS,
  LOSS_PROBABILITY_LABELS,
  OCCURRENCE_CATEGORY_LABELS,
  OCCURRENCE_STATUS_LABELS,
  PRIORITY_LABELS,
  PROCESS_PHASE_LABELS,
  PROCESS_STATUS_LABELS,
  RENEWAL_TYPE_LABELS,
  RISK_LEVEL_LABELS,
  ROLE_LABELS,
  ROUTINE_TYPE_LABELS,
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
  VALIDATION_STATUS_LABELS,
  ANALYSIS_REVIEW_STATUS_LABELS,
  type EntityType,
} from "@/domain/enums";
import { formatDate, formatDateTime, formatMoneyCents, formatNumber } from "@/lib/format";

/**
 * Client-safe helpers that turn audit entries (action ids, field diffs) into
 * pt-BR text: "Situação: Ativo → Encerrado". Unknown fields fall back to the
 * raw key so nothing is hidden.
 */

const FIELD_LABELS: Record<string, string> = {
  // common
  title: "Título",
  name: "Nome",
  description: "Descrição",
  status: "Situação",
  riskLevel: "Risco",
  riskRationale: "Justificativa do risco",
  priority: "Prioridade",
  responsibleId: "Responsável",
  assigneeId: "Atribuída a",
  unitId: "Unidade",
  isConfidential: "Confidencial",
  confidentiality: "Confidencialidade",
  legalHold: "Retenção legal (legal hold)",
  retentionUntil: "Reter até",
  dataOrigin: "Origem dos dados",
  origin: "Origem",
  externalId: "Identificador externo",
  externalSource: "Fonte externa",
  closedAt: "Encerrado em",
  deletedAt: "Excluído em",
  // processes
  number: "Número",
  court: "Tribunal / órgão",
  courtDivision: "Vara / câmara",
  jurisdiction: "Comarca",
  area: "Área",
  phase: "Fase",
  filedAt: "Data de distribuição",
  claimAmountCents: "Valor da causa",
  provisionAmountCents: "Valor provisionado",
  estimatedExposureCents: "Exposição estimada",
  lossProbability: "Probabilidade de perda",
  counselName: "Escritório / advogado externo",
  linkedOccurrenceId: "Ocorrência de origem",
  linkedProcessId: "Processo vinculado",
  // occurrences
  category: "Categoria",
  facts: "Fatos",
  occurredOn: "Data da ocorrência",
  reportedOn: "Data do relato",
  reportedById: "Relatado por",
  areasInvolved: "Áreas envolvidas",
  involvedParties: "Pessoas envolvidas",
  missingInformation: "Informações faltantes",
  // contracts
  counterparty: "Contraparte",
  counterpartyDocument: "Documento da contraparte",
  type: "Tipo",
  valueCents: "Valor",
  startDate: "Início da vigência",
  endDate: "Fim da vigência",
  renewalType: "Renovação",
  renewalNoticeDays: "Aviso prévio (dias)",
  // documents
  fileName: "Arquivo",
  currentVersionNumber: "Versão atual",
  changeNote: "Nota da versão",
  // deadlines / tasks
  dueDate: "Vencimento",
  kind: "Tipo",
  validationStatus: "Validação",
  validationNote: "Nota da validação",
  completedAt: "Concluído em",
  processId: "Processo",
  occurrenceId: "Ocorrência",
  contractId: "Contrato",
  // analyses
  reviewStatus: "Revisão",
  reviewNote: "Nota da revisão",
  // users, teams, units, organization
  email: "E-mail",
  role: "Perfil",
  jobTitle: "Cargo",
  isActive: "Ativo",
  teamIds: "Equipes",
  memberIds: "Membros",
  leaderId: "Líder",
  code: "Código",
  password: "Senha",
  passwordHash: "Senha",
  enabled: "Ativa",
  intervalMinutes: "Intervalo (minutos)",
  autoRefresh: "Reanálise automática",
  maxPerRun: "Máximo por execução",
  monthlyTokenBudget: "Limite mensal de tokens de IA",
  maxInputChars: "Máximo de caracteres por análise",
  autoAnalyzeOnUpload: "Analisar documentos automaticamente",
  upcomingDeadlineDays: "Alerta de prazos (dias)",
  contractExpirationDays: "Alerta de vencimento de contratos (dias)",
  closedRecordRetentionDays: "Retenção de registros encerrados (dias)",
  auditLogRetentionDays: "Retenção da auditoria (dias)",
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

/** Enum label maps per field, optionally specialized by entity type. */
function enumLabels(entityType: EntityType | null, key: string): Record<string, string> | null {
  switch (key) {
    case "status":
      if (entityType === "legal_process") return PROCESS_STATUS_LABELS;
      if (entityType === "occurrence") return OCCURRENCE_STATUS_LABELS;
      if (entityType === "contract") return CONTRACT_STATUS_LABELS;
      if (entityType === "deadline") return DEADLINE_STATUS_LABELS;
      if (entityType === "task") return TASK_STATUS_LABELS;
      return null;
    case "category":
      if (entityType === "occurrence") return OCCURRENCE_CATEGORY_LABELS;
      if (entityType === "document") return DOCUMENT_CATEGORY_LABELS;
      return null;
    case "kind":
      if (entityType === "deadline") return DEADLINE_KIND_LABELS;
      if (entityType === "task") return TASK_KIND_LABELS;
      return null;
    case "type":
      if (entityType === "contract") return CONTRACT_TYPE_LABELS;
      if (entityType === "organization") return ROUTINE_TYPE_LABELS;
      return null;
    case "riskLevel":
      return RISK_LEVEL_LABELS;
    case "priority":
      return PRIORITY_LABELS;
    case "area":
      return LEGAL_AREA_LABELS;
    case "phase":
      return PROCESS_PHASE_LABELS;
    case "confidentiality":
      return CONFIDENTIALITY_LABELS;
    case "lossProbability":
      return LOSS_PROBABILITY_LABELS;
    case "role":
      return ROLE_LABELS;
    case "renewalType":
      return RENEWAL_TYPE_LABELS;
    case "validationStatus":
      return VALIDATION_STATUS_LABELS;
    case "reviewStatus":
      return ANALYSIS_REVIEW_STATUS_LABELS;
    case "dataOrigin":
    case "origin":
      return DATA_ORIGIN_LABELS;
    default:
      return null;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Human-readable value of one side of a diff.
 * `names` resolves ids (users, units, teams) to names when the service could do so.
 */
export function formatChangeValue(
  key: string,
  value: unknown,
  entityType: EntityType | null,
  names: Record<string, string> = {},
): string {
  if (value === null || value === undefined || value === "") return "(vazio)";
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "number") {
    if (key.endsWith("Cents")) return formatMoneyCents(value);
    return formatNumber(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "(nenhum)";
    return value.map((v) => formatChangeValue(key, v, entityType, names)).join(", ");
  }
  if (typeof value === "string") {
    const labels = enumLabels(entityType, key);
    if (labels && value in labels) return labels[value];
    if (UUID.test(value)) return names[value] ?? "registro vinculado";
    if (ISO_DATE.test(value)) return formatDate(value);
    if (ISO_TIMESTAMP.test(value)) return formatDateTime(new Date(value));
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Acesso ao sistema",
  "auth.logout": "Saída do sistema",
  "auth.login_failed": "Tentativa de acesso sem sucesso",
  "user.create": "Usuário criado",
  "user.update": "Usuário alterado",
  "user.password_reset": "Senha redefinida",
  "team.create": "Equipe criada",
  "team.update": "Equipe alterada",
  "team.delete": "Equipe excluída",
  "unit.create": "Unidade criada",
  "unit.update": "Unidade alterada",
  "unit.delete": "Unidade excluída",
  "unit.deactivate": "Unidade desativada",
  "organization.settings_update": "Configurações da organização alteradas",
  "routine.update": "Rotina alterada",
  "routine.run_requested": "Execução de rotina solicitada",
  "jobs.process_requested": "Processamento da fila solicitado",
  "document.download": "Download de documento",
  "document.upload": "Envio de documento",
  "document.version_add": "Nova versão de documento",
  "analysis.request": "Análise de IA solicitada",
  "analysis.review": "Análise de IA revisada",
  "analysis.completed": "Análise de IA concluída",
  "analysis.failed": "Falha em análise de IA",
  "analysis.apply_task": "Tarefa criada a partir de sugestão da IA",
  "analysis.apply_deadline": "Prazo sugerido pela IA enviado para validação",
  "deadline.validate": "Validação de prazo sugerido",
  "deadline.suggest": "Prazo sugerido pela IA",
  "deadline.status": "Mudança de situação · Prazo",
  "task.status": "Mudança de situação · Tarefa",
  "legal_process.party_add": "Parte incluída no processo",
  "legal_process.party_update": "Parte do processo alterada",
  "legal_process.party_remove": "Parte removida do processo",
  "legal_process.event_add": "Andamento registrado no processo",
  "legal_process.event_remove": "Andamento removido do processo",
  "occurrence.link_process": "Ocorrência vinculada a processo",
  "occurrence.unlink_process": "Vínculo da ocorrência com processo removido",
  "contract_obligation.create": "Obrigação contratual cadastrada",
  "contract_obligation.update": "Obrigação contratual alterada",
  "contract_obligation.status_change": "Situação de obrigação contratual alterada",
  "contract_obligation.delete": "Obrigação contratual excluída",
  "comment.create": "Comentário publicado",
  "comment.delete": "Comentário excluído",
  "alert.resolve": "Alerta resolvido",
};

const VERB_LABELS: Record<string, string> = {
  create: "Criação",
  update: "Alteração",
  delete: "Exclusão",
  restore: "Restauração",
  archive: "Arquivamento",
  close: "Encerramento",
  link: "Vinculação",
  unlink: "Desvinculação",
  upload: "Envio",
  download: "Download",
  view: "Consulta",
  request: "Solicitação",
  review: "Revisão",
  validate: "Validação",
  reject: "Rejeição",
  resolve: "Resolução",
  status_change: "Mudança de situação",
  comment: "Comentário",
  apply: "Aplicação de sugestão",
};

const ACTION_PREFIX_ENTITY: Record<string, EntityType> = {
  legal_process: "legal_process",
  process: "legal_process",
  occurrence: "occurrence",
  contract: "contract",
  document: "document",
  task: "task",
  deadline: "deadline",
  analysis: "analysis",
  user: "user",
  team: "team",
  unit: "unit",
  organization: "organization",
};

/** pt-BR label for a dotted action id such as `legal_process.update`. */
export function actionLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const [prefix, ...rest] = action.split(".");
  const verb = rest.join(".");
  const entity = ACTION_PREFIX_ENTITY[prefix];
  const verbLabel = VERB_LABELS[verb];
  if (entity && verbLabel) return `${verbLabel} · ${ENTITY_TYPE_LABELS[entity]}`;
  if (verbLabel) return verbLabel;
  return action;
}
