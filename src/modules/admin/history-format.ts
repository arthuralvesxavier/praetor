import { formatBp } from "@/domain/contingency";
import {
  ASSIGNMENT_METHOD_LABELS,
  CASE_BRIEF_STATUS_LABELS,
  CLOSURE_REASON_LABELS,
  CONFIDENTIALITY_LABELS,
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  DATA_ORIGIN_LABELS,
  DEADLINE_KIND_LABELS,
  DEADLINE_STATUS_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  EMAIL_STATUS_LABELS,
  EMAIL_TEMPLATE_LABELS,
  ENTITY_TYPE_LABELS,
  GUARANTEE_KIND_LABELS,
  GUARANTEE_STATUS_LABELS,
  HEARING_KIND_LABELS,
  HEARING_MODE_LABELS,
  HEARING_STATUS_LABELS,
  IMPORT_BATCH_STATUS_LABELS,
  INSTALLMENT_STATUS_LABELS,
  INTAKE_SOURCE_LABELS,
  INTAKE_STATUS_LABELS,
  LEGAL_AREA_LABELS,
  LIABILITY_NATURE_LABELS,
  LOSS_PROBABILITY_LABELS,
  OCCURRENCE_CATEGORY_LABELS,
  OCCURRENCE_STATUS_LABELS,
  PRIORITY_LABELS,
  PROCESS_INSTANCE_LABELS,
  PROCESS_PHASE_DISPLAY_LABELS,
  PROCESS_STATUS_LABELS,
  RENEWAL_TYPE_LABELS,
  RISK_LEVEL_LABELS,
  ROLE_LABELS,
  ROUTINE_TYPE_LABELS,
  SETTLEMENT_STATUS_LABELS,
  SNAPSHOT_STATUS_LABELS,
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
  VALIDATION_STATUS_LABELS,
  VALUATION_KIND_LABELS,
  VALUATION_SOURCE_LABELS,
  VALUATION_STATUS_LABELS,
  ANALYSIS_REVIEW_STATUS_LABELS,
  CORRECTION_INDEX_LABELS,
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
  upcomingHearingDays: "Alerta de audiências (dias)",
  installmentDueDays: "Alerta de parcelas de acordo (dias)",
  // v2 — carteira (processos)
  companyId: "Empresa",
  lawFirmId: "Escritório externo",
  instance: "Instância",
  processClass: "Classe processual",
  city: "Cidade",
  state: "UF",
  phaseDetail: "Fase (como na fonte)",
  liquidatedAmountCents: "Valor liquidado / apurado",
  riskPercentageBp: "Percentual de risco",
  closureReason: "Motivo de saída da carteira",
  needsVerification: "Pendente de conferência",
  verificationNote: "Nota da conferência",
  lastMovementAt: "Última movimentação",
  liabilityNature: "Natureza da responsabilidade",
  // v2 — empresas e escritórios
  document: "CNPJ",
  contactName: "Contato",
  contactEmail: "E-mail do contato",
  // v2 — parâmetros
  riskPercentRemote: "Percentual de provisão (remota)",
  riskPercentPossible: "Percentual de provisão (possível)",
  riskPercentProbable: "Percentual de provisão (provável)",
  confidenceThreshold: "Confiança mínima para conferência em lote",
  idleGuaranteeDays: "Garantia parada após (dias)",
  rulesVersion: "Versão das regras de risco",
  senderName: "Nome do remetente (e-mail simulado)",
  senderAddress: "Endereço do remetente (fictício)",
  notifyOnBriefReady: "Avisar quando a análise preliminar ficar pronta",
  notifyOnAssignment: "Avisar quando um processo for atribuído",
  autoAssign: "Distribuição automática na entrada",
  autoGenerateBrief: "Análise preliminar automática (simulada)",
  autoNotify: "Notificação automática ao advogado (simulada)",
  datajudEnabled: "Acompanhamento automático no DataJud",
  syncIntervalHours: "Intervalo entre consultas ao DataJud (horas)",
  maxRequestsPerMinute: "Requisições por minuto por tribunal",
  batchSize: "Números por consulta ao DataJud",
  autoApplyPhase: "Aplicar mudanças de fase inequívocas do DataJud",
  enrichOnIntake: "Completar processos recebidos por API com o DataJud",
  simulatedFeedEnabled: "Chegada automática simulada",
  simulatedFeedIntervalMinutes: "Intervalo da chegada simulada (minutos)",
  // v2 — contingências, acordos, audiências, entrada
  amountCents: "Valor",
  totalAmountCents: "Valor total",
  baseDate: "Data-base",
  classification: "Classificação de risco",
  percentageBp: "Percentual aplicado",
  opinion: "Parecer",
  effectiveFrom: "Vigente desde",
  correctionIndex: "Índice de atualização",
  defaultCorrectionIndex: "Índice de atualização dos novos valores",
  source: "Fonte",
  reason: "Motivo",
  confidence: "Confiança",
  isEstimate: "Estimativa",
  installmentsCount: "Número de parcelas",
  proposedAt: "Proposto em",
  signedAt: "Firmado em",
  homologatedAt: "Homologado em",
  paidAt: "Pago em",
  depositedAt: "Depositado em",
  statusChangedAt: "Situação alterada em",
  notes: "Observações",
  scheduledAt: "Data e hora",
  mode: "Formato",
  location: "Local",
  meetingUrl: "Link da sala virtual",
  outcome: "Resultado",
  assignedToId: "Responsável atribuído",
  assignmentMethod: "Forma de atribuição",
  period: "Competência",
  template: "Modelo de e-mail",
  approvalNote: "Nota da aprovação",
  rejectionReason: "Motivo da rejeição",
  // pedidos do processo
  claimCategory: "Categoria do pedido",
  claimedAmountCents: "Valor do pedido",
  claimAmountBaseDate: "Data-base do valor do pedido",
  claimCorrectionIndex: "Índice de atualização do pedido",
  claimInstance: "Instância do pedido",
  claimDescription: "Descrição do pedido",
  claimStatus: "Situação do pedido",
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
      if (entityType === "valuation" || entityType === "risk_assessment") return VALUATION_STATUS_LABELS;
      if (entityType === "guarantee") return GUARANTEE_STATUS_LABELS;
      if (entityType === "settlement") return SETTLEMENT_STATUS_LABELS;
      if (entityType === "hearing") return HEARING_STATUS_LABELS;
      if (entityType === "case_brief") return CASE_BRIEF_STATUS_LABELS;
      if (entityType === "intake") return INTAKE_STATUS_LABELS;
      if (entityType === "snapshot") return SNAPSHOT_STATUS_LABELS;
      if (entityType === "import_batch") return IMPORT_BATCH_STATUS_LABELS;
      if (entityType === "email") return EMAIL_STATUS_LABELS;
      return null;
    case "category":
      if (entityType === "occurrence") return OCCURRENCE_CATEGORY_LABELS;
      if (entityType === "document") return DOCUMENT_CATEGORY_LABELS;
      return null;
    case "kind":
      if (entityType === "deadline") return DEADLINE_KIND_LABELS;
      if (entityType === "task") return TASK_KIND_LABELS;
      if (entityType === "valuation") return VALUATION_KIND_LABELS;
      if (entityType === "guarantee") return GUARANTEE_KIND_LABELS;
      if (entityType === "hearing") return HEARING_KIND_LABELS;
      return null;
    case "source":
      if (entityType === "valuation") return VALUATION_SOURCE_LABELS;
      if (entityType === "intake") return INTAKE_SOURCE_LABELS;
      return null;
    case "mode":
      if (entityType === "hearing") return HEARING_MODE_LABELS;
      return null;
    case "instance":
      return PROCESS_INSTANCE_LABELS;
    case "closureReason":
      return CLOSURE_REASON_LABELS;
    case "classification":
      return LOSS_PROBABILITY_LABELS;
    case "assignmentMethod":
      return ASSIGNMENT_METHOD_LABELS;
    case "liabilityNature":
      return LIABILITY_NATURE_LABELS;
    case "template":
      return EMAIL_TEMPLATE_LABELS;
    case "installmentStatus":
      return INSTALLMENT_STATUS_LABELS;
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
      // History may hold phases of the previous model (before P0.5): shown with their former labels.
      return PROCESS_PHASE_DISPLAY_LABELS;
    case "confidentiality":
      return CONFIDENTIALITY_LABELS;
    case "lossProbability":
      return LOSS_PROBABILITY_LABELS;
    case "correctionIndex":
    case "defaultCorrectionIndex":
      return CORRECTION_INDEX_LABELS;
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
    if (key.endsWith("Bp")) return formatBp(value);
    if (key.startsWith("riskPercent") || key === "confidenceThreshold") return `${formatNumber(value)}%`;
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
  // v2
  "legal_process.view_confidential": "Acesso a processo sigiloso",
  "audit.export": "Exportação da trilha de auditoria",
  "company.create": "Empresa cadastrada",
  "company.update": "Empresa alterada",
  "company.delete": "Empresa excluída",
  "company.deactivate": "Empresa desativada",
  "law_firm.create": "Escritório externo cadastrado",
  "law_firm.update": "Escritório externo alterado",
  "law_firm.delete": "Escritório externo excluído",
  "law_firm.deactivate": "Escritório externo desativado",
  "organization.contingency_settings_update": "Parâmetros de contingência alterados",
  "organization.email_intake_settings_update": "Configurações de e-mail (simulado) e de entrada alteradas",
  // v2 — carteira
  "legal_process.close": "Processo retirado da carteira ativa",
  "legal_process.reactivate": "Processo reativado na carteira ativa",
  "legal_process.verification_flag": "Processo marcado como pendente de conferência",
  "legal_process.verification_resolve": "Conferência do processo concluída",
  "legal_process.export": "Exportação da carteira de processos",
  "legal_process.instance_add": "Instância incluída no processo",
  "legal_process.instance_update": "Instância do processo alterada",
  "legal_process.instance_remove": "Instância removida do processo",
  "legal_process.assign": "Responsável do processo definido",
  "legal_process.phase_migration": "Fase e instância separadas (migração do modelo)",
  "legal_process.phase_migration_rollback": "Migração de fase e instância revertida",
  // v2 — contingências
  "valuation.propose": "Valor proposto para conferência",
  "valuation.create": "Valor registrado como oficial",
  "valuation.approve": "Valor conferido e oficializado",
  "valuation.correct": "Valor proposto corrigido na conferência",
  "valuation.reject": "Valor proposto rejeitado",
  "valuation.extinction": "Quitação registrada",
  "guarantee.create": "Garantia vinculada",
  "guarantee.update": "Garantia alterada",
  "guarantee.status_change": "Situação de garantia alterada",
  "guarantee.delete": "Garantia excluída",
  "risk_assessment.create": "Classificação de risco registrada",
  "risk_assessment.suggest": "Classificação sugerida por regra (não oficial)",
  "risk_assessment.approve": "Sugestão de classificação aprovada",
  "risk_assessment.reject": "Sugestão de classificação rejeitada",
  "risk_assessment.derive": "Classificação de risco derivada dos pedidos",
  "risk_assessment.override": "Classificação de risco definida manualmente (diferente da derivada dos pedidos)",
  "claim.create": "Pedido incluído no processo",
  "claim.update": "Pedido do processo alterado",
  "claim.delete": "Pedido do processo excluído",
  "claim.suggest": "Pedidos sugeridos pela análise preliminar",
  "claim.confirm": "Pedido sugerido confirmado",
  "claim.dismiss": "Pedido sugerido descartado",
  "claim_assessment.create": "Avaliação de risco de pedido registrada",
  "settlement.create": "Acordo registrado",
  "settlement.update_terms": "Termos do acordo alterados",
  "settlement.status_change": "Situação do acordo alterada",
  "settlement.update_notes": "Observações do acordo alteradas",
  "settlement.installment_paid": "Parcela de acordo paga",
  "settlement.installment_unpaid": "Pagamento de parcela desfeito",
  "snapshot.generate": "Prévia do fechamento mensal calculada",
  "snapshot.close": "Competência mensal fechada",
  "snapshot.export": "Fechamento mensal exportado (CSV)",
  "provision_memo.export": "Memória de cálculo da provisão exportada",
  // v2 — audiências
  "hearing.create": "Audiência cadastrada",
  "hearing.update": "Audiência alterada",
  "hearing.status_change": "Situação de audiência alterada",
  // v2 — importação
  "import_batch.analyze": "Planilha analisada para importação",
  "import_batch.commit": "Importação de planilha confirmada",
  "import_batch.rollback": "Importação de planilha desfeita",
  "import_batch.distribute": "Distribuição após importação de planilha",
  "import_batch.download": "Download da planilha original da importação",
  "import_batch.export_issues": "Exportação das inconsistências da importação (CSV)",
  // v2 — entrada, distribuição, e-mails
  "intake.create": "Entrada de processo registrada",
  // Coleta no DataJud e API de entrada
  "legal_process.court_sync": "Atualização automática pelo DataJud (CNJ)",
  "organization.court_sync_request": "Sincronização da carteira com o DataJud solicitada",
  "organization.integration_settings_update": "Parâmetros do DataJud e da chegada simulada alterados",
  "api_key.create": "Chave de API criada",
  "api_key.revoke": "Chave de API revogada",
  "inbound.receive": "Processo recebido por API",
  "inbound.update_existing": "Novo envio por API de processo já cadastrado",
  "intake.process_start": "Processamento da entrada iniciado",
  "intake.reprocess": "Reprocessamento da entrada solicitado",
  "intake.brief_request": "Análise preliminar solicitada na entrada",
  "intake.email_resend": "E-mail (simulado) reenviado na entrada",
  "distribution_rule.create": "Regra de distribuição criada",
  "distribution_rule.update": "Regra de distribuição alterada",
  "distribution_rule.delete": "Regra de distribuição excluída",
  "distribution_rule.reorder": "Ordem das regras de distribuição alterada",
  "email.simulated_send": "Envio de e-mail simulado registrado",
  "email.resend": "Reenvio de e-mail simulado registrado",
  // v2 — contratos e relatórios
  "contract.renew": "Renovação de contrato registrada",
  "contract.terminate": "Rescisão de contrato registrada",
  "contract_obligation.fulfill": "Obrigação contratual cumprida",
  "report.export": "Exportação de relatório",
  // Painéis Power BI
  "organization.bi_settings_update": "Configuração dos painéis Power BI alterada",
  "bi.embed_view": "Painel Power BI exibido",
  "bi.refresh_request": "Atualização dos painéis Power BI solicitada",
  "bi.connection_test": "Teste de conexão com o Power BI",
  // Relatórios jurídicos (PDF)
  "legal_report.generate": "Relatório jurídico gerado (PDF pendente de revisão)",
  "legal_report.regenerate": "Nova versão de relatório jurídico gerada (anterior substituída)",
  "legal_report.approve": "Relatório jurídico aprovado",
  "legal_report.download": "Download do PDF de relatório jurídico",
  "organization.legal_reports_settings_update": "Parâmetros dos relatórios jurídicos alterados",
  "process_scenario.create": "Cenário do processo registrado",
  "process_scenario.propose": "Cenários propostos pelo sistema a partir dos pedidos (sujeitos a revisão)",
  // Índices de correção (P1.7)
  "valuation.correction_index_set": "Índice de atualização de valor informado",
  "valuation.correction_index_replace": "Índice de atualização de valor oficial trocado (novo registro)",
  "organization.correction_index_default_update": "Índice de atualização dos novos valores alterado",
  "organization.index_series_refresh_request": "Coleta das séries de índices (Banco Central) solicitada",
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
  // v2
  approve: "Aprovação",
  propose: "Proposta",
  supersede: "Substituição",
  commit: "Confirmação",
  rollback: "Desfazimento",
  analyze: "Análise",
  send: "Envio",
  simulate: "Simulação",
  assign: "Atribuição",
  reassign: "Redistribuição",
  generate: "Geração",
  regenerate: "Nova geração",
  edit: "Edição",
  export: "Exportação",
  import: "Importação",
  view_confidential: "Acesso a registro sigiloso",
  activate: "Ativação",
  deactivate: "Desativação",
  release: "Liberação",
  pay: "Pagamento",
  cancel: "Cancelamento",
  reschedule: "Redesignação",
  notify: "Notificação",
  receive: "Recebimento",
  fulfill: "Cumprimento",
  breach: "Descumprimento",
  reopen: "Reabertura",
  submit: "Envio",
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
  // v2
  company: "company",
  law_firm: "law_firm",
  hearing: "hearing",
  settlement: "settlement",
  valuation: "valuation",
  guarantee: "guarantee",
  risk_assessment: "risk_assessment",
  case_brief: "case_brief",
  brief: "case_brief",
  intake: "intake",
  email: "email",
  import_batch: "import_batch",
  import: "import_batch",
  snapshot: "snapshot",
  distribution_rule: "distribution_rule",
  distribution: "distribution_rule",
  api_key: "api_key",
  legal_report: "legal_report",
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
