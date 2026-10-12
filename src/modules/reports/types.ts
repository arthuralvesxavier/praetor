/**
 * Report contracts shared by the service, the export route and the UI
 * (client-safe: types and labels only, no server imports).
 *
 * Business rules carried by every report:
 *  RN-02  valor da causa and valor liquidado are never added together — they are
 *         always separate, labeled columns;
 *  RN-03  null is not zero: unknown values are counted ("não apurado") and never
 *         summed as 0 (CSV cells stay empty);
 *  RN-07  estimates (exposure/provision based on the claim value) are always
 *         flagged and kept in their own columns.
 */
import type { MoneyBucket, SnapshotParams } from "@/domain/contingency";
import type {
  ClosureReason,
  LossProbability,
  ProcessInstance,
  ProcessPhase,
  SnapshotStatus,
  ValuationKind,
} from "@/domain/enums";

export const REPORT_TYPES = ["carteira", "exposicao", "provisao", "auditoria", "movimentacao", "responsaveis"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  carteira: "Carteira por empresa e unidade",
  exposicao: "Exposição por tribunal, cidade, fase e instância",
  provisao: "Provisão por competência",
  auditoria: "Carta de auditoria",
  movimentacao: "Movimentação do período",
  responsaveis: "Por responsável e escritório",
};

/** Short tab labels. */
export const REPORT_TAB_LABELS: Record<ReportType, string> = {
  carteira: "Carteira",
  exposicao: "Exposição",
  provisao: "Provisão",
  auditoria: "Carta de auditoria",
  movimentacao: "Movimentação",
  responsaveis: "Responsáveis",
};

export const REPORT_TYPE_DESCRIPTIONS: Record<ReportType, string> = {
  carteira:
    "Carteira ativa por empresa e por unidade: quantidade de processos (CNJ únicos), valor da causa e valor liquidado lado a lado, exposição oficial e estimada e provisão por classificação de risco.",
  exposicao:
    "Posição atual da carteira ativa por tribunal, cidade, fase e instância, comparada com o fechamento mensal anterior quando ele existe.",
  provisao:
    "Provisão por classificação de risco lida de uma competência FECHADA (imutável), com a movimentação em relação à competência fechada anterior.",
  auditoria:
    "Relação de processos com a posição na data-base (classificação, percentual, provisão e ressalvas), em layout formal para impressão e assinatura do advogado responsável.",
  movimentacao:
    "Entradas, encerramentos (com o motivo), mudanças de fase e alterações de valores oficiais no período, a partir das datas dos processos, das valorações e da trilha de auditoria.",
  responsaveis: "Carteira ativa por advogado responsável e por escritório externo.",
};

export type ReportFilters = {
  companyId?: string;
  unitId?: string;
  /** Competência `YYYY-MM`. */
  period?: string;
  /** Período `YYYY-MM-DD` (relatório de movimentação). */
  from?: string;
  to?: string;
};

export type ExportFormat = "csv" | "xlsx";

/** Who the numbers represent (row visibility). */
export type ReportScope = {
  /** Sees the whole (non-confidential) portfolio of the organization. */
  orgWide: boolean;
  includesConfidential: boolean;
  /** pt-BR sentence shown above every report. */
  label: string;
  /** Label of the totals row. */
  totalLabel: string;
};

export type ReportContext = {
  scope: ReportScope;
  generatedAt: Date;
  organizationName: string;
  /** pt-BR description of the applied filters ("Empresa: X · Unidade: Y"). */
  filterSummary: string;
};

/** A group of processes with its money bucket (MoneyBucket from @/domain/contingency). */
export type BucketRow = {
  key: string;
  label: string;
  /** Distinct CNJ numbers in the group (RN-01: instances are never counted twice). */
  processCount: number;
  bucket: MoneyBucket;
};

// ---------------------------------------------------------------------------
// Carteira
// ---------------------------------------------------------------------------

export type PortfolioReport = ReportContext & {
  type: "carteira";
  byCompany: BucketRow[];
  byUnit: BucketRow[];
  byClassification: BucketRow[];
  totals: BucketRow;
  hasEstimates: boolean;
};

// ---------------------------------------------------------------------------
// Exposição
// ---------------------------------------------------------------------------

export const EXPOSURE_DIMENSIONS = ["court", "city", "phase", "instance"] as const;
export type ExposureDimension = (typeof EXPOSURE_DIMENSIONS)[number];
export const EXPOSURE_DIMENSION_LABELS: Record<ExposureDimension, string> = {
  court: "Tribunal",
  city: "Cidade",
  phase: "Fase",
  instance: "Instância",
};

export type PreviousPosition = {
  processCount: number;
  exposureCents: number;
  exposureEstimateCents: number;
  exposureUnknown: number;
};

export type ExposureRow = BucketRow & { previous: PreviousPosition | null };

export type SnapshotRef = { id: string; period: string; referenceDate: string; status: SnapshotStatus };

export type ExposureReport = ReportContext & {
  type: "exposicao";
  /** Snapshot used for the comparison (null when none exists). */
  comparison: SnapshotRef | null;
  comparisonNote: string | null;
  dimensions: { key: ExposureDimension; label: string; rows: ExposureRow[] }[];
  totals: ExposureRow;
  hasEstimates: boolean;
};

// ---------------------------------------------------------------------------
// Provisão
// ---------------------------------------------------------------------------

export type ClassificationKey = LossProbability | "unclassified";
export const CLASSIFICATION_KEYS: readonly ClassificationKey[] = ["probable", "possible", "remote", "unclassified"];
/** LOSS_PROBABILITY_LABELS plus the "not classified" bucket. */
export const CLASSIFICATION_LABELS: Record<ClassificationKey, string> = {
  probable: "Provável",
  possible: "Possível",
  remote: "Remota",
  unclassified: "Sem classificação",
};

export type ProvisionAmounts = { provisionCents: number; provisionEstimateCents: number };

export type ProvisionClassRow = {
  key: ClassificationKey;
  label: string;
  /** Percentage of the classification in the snapshot parameters (null for "sem classificação"). */
  percentageBp: number | null;
  processCount: number;
  current: ProvisionAmounts;
  previous: (ProvisionAmounts & { processCount: number }) | null;
};

export const MOVEMENT_KINDS = ["entered", "left", "changed", "unchanged"] as const;
export type ProvisionMovementKind = (typeof MOVEMENT_KINDS)[number];
export const PROVISION_MOVEMENT_LABELS: Record<ProvisionMovementKind, string> = {
  entered: "Entradas na provisão",
  left: "Saídas / baixas",
  changed: "Atualizações de valor ou classificação",
  unchanged: "Sem alteração",
};

export type ProvisionMovementRow = ProvisionAmounts & { kind: ProvisionMovementKind; processCount: number };

export type ProvisionItem = {
  processId: string;
  number: string;
  classification: LossProbability | null;
  percentageBp: number | null;
  claimCents: number | null;
  liquidatedCents: number | null;
  guaranteesCents: number;
  provisionCents: number | null;
  provisionIsEstimate: boolean;
  /** Provision of the same process in the previous closed period (null when absent there). */
  previousProvisionCents: number | null;
  previousIsEstimate: boolean;
  movement: ProvisionMovementKind | null;
};

export type ProvisionReport = ReportContext & {
  type: "provisao";
  /** Closed periods available (YYYY-MM, newest first). */
  closedPeriods: string[];
  snapshot: (SnapshotRef & { closedAt: Date | null; closedByName: string | null; params: SnapshotParams }) | null;
  previous: SnapshotRef | null;
  byClassification: ProvisionClassRow[];
  totals: ProvisionClassRow;
  /** Null when there is no previous closed period. */
  movement: { opening: ProvisionAmounts; rows: ProvisionMovementRow[]; closing: ProvisionAmounts } | null;
  items: ProvisionItem[];
  hasEstimates: boolean;
};

// ---------------------------------------------------------------------------
// Carta de auditoria
// ---------------------------------------------------------------------------

export type AuditLetterRow = {
  processId: string;
  number: string;
  title: string;
  court: string | null;
  courtDivision: string | null;
  instance: ProcessInstance | null;
  phase: ProcessPhase | null;
  classification: LossProbability | null;
  percentageBp: number | null;
  claimCents: number | null;
  liquidatedCents: number | null;
  guaranteesCents: number;
  exposureCents: number | null;
  exposureIsEstimate: boolean;
  provisionCents: number | null;
  provisionIsEstimate: boolean;
  caveats: string[];
};

export type AuditLetterReport = ReportContext & {
  type: "auditoria";
  /** Data-base of the positions (YYYY-MM-DD). */
  baseDate: string;
  source: "snapshot" | "current";
  snapshot: (SnapshotRef & { closedAt: Date | null }) | null;
  closedPeriods: string[];
  rows: AuditLetterRow[];
  totals: {
    processCount: number;
    claimCents: number;
    claimUnknown: number;
    liquidatedCents: number;
    liquidatedUnknown: number;
    provisionCents: number;
    provisionEstimateCents: number;
    unclassified: number;
    byClassification: Record<ClassificationKey, number>;
  };
  generalCaveats: string[];
  hasEstimates: boolean;
};

// ---------------------------------------------------------------------------
// Movimentação
// ---------------------------------------------------------------------------

export const MOVEMENT_EVENT_KINDS = ["added", "closed", "value_change", "phase_change", "status_change"] as const;
export type MovementEventKind = (typeof MOVEMENT_EVENT_KINDS)[number];
export const MOVEMENT_EVENT_LABELS: Record<MovementEventKind, string> = {
  added: "Entrada na carteira",
  closed: "Encerramento",
  value_change: "Alteração de valor oficial",
  phase_change: "Mudança de fase",
  status_change: "Mudança de situação",
};

export type MovementEvent = {
  /** YYYY-MM-DD (calendar date in America/Sao_Paulo). */
  date: string;
  kind: MovementEventKind;
  processId: string;
  number: string;
  title: string;
  detail: string;
  closureReason: ClosureReason | null;
  valuationKind: ValuationKind | null;
  previousCents: number | null;
  newCents: number | null;
  isEstimate: boolean;
};

export type MovementReport = ReportContext & {
  type: "movimentacao";
  from: string;
  to: string;
  summary: {
    added: number;
    closed: number;
    closedByReason: { reason: ClosureReason | "unknown"; label: string; count: number }[];
    valueChanges: number;
    phaseChanges: number;
    statusChanges: number;
  };
  events: MovementEvent[];
  /** Proposed (not yet official) valuations created in the period — not listed as changes. */
  pendingProposedValuations: number;
  /** True when the list was cut at the safety limit (see the note on screen). */
  truncated: boolean;
};

// ---------------------------------------------------------------------------
// Responsáveis
// ---------------------------------------------------------------------------

export type ResponsibleRow = BucketRow & { unclassified: number };

export type ResponsiblesReport = ReportContext & {
  type: "responsaveis";
  lawyers: ResponsibleRow[];
  lawFirms: ResponsibleRow[];
  totals: ResponsibleRow;
  hasEstimates: boolean;
};

export type ReportData =
  | PortfolioReport
  | ExposureReport
  | ProvisionReport
  | AuditLetterReport
  | MovementReport
  | ResponsiblesReport;

/** Options for the filter controls of /relatorios. */
export type ReportFilterOptions = {
  companies: { id: string; name: string }[];
  units: { id: string; name: string }[];
  snapshots: { period: string; status: SnapshotStatus; referenceDate: string }[];
};
