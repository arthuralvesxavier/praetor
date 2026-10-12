/**
 * Plano da importação (puro, sem I/O): agrupa as linhas por número CNJ,
 * escolhe a linha efetiva de cada instância, detecta divergências entre abas,
 * decide a instância atual e compara com o que já existe na base.
 *
 * Decisões documentadas:
 *   - RN-01/RN-09: um processo por CNJ (todas as abas); cada instância vira uma
 *     linha de `process_instances`. Contagens nunca somam instâncias.
 *   - Base oficial = aba consolidada. Para o mesmo CNJ + instância, a linha da
 *     aba consolidada é a efetiva; as linhas das abas por instância servem para
 *     conferência. Se o CNJ + instância só existe numa aba por instância, essa
 *     linha passa a ser a efetiva (informado).
 *   - Divergência entre abas (valor da causa, valor liquidado, fase, tribunal,
 *     órgão julgador) gera a inconsistência `value_divergence` com os dois
 *     valores. Valores monetários divergentes viram valorações PROPOSTAS com o
 *     motivo "Divergência entre abas: …" (RN-08: registrar, nunca sobrescrever).
 *   - Instância atual = a mais alta entre as que NÃO constam como baixadas
 *     ("baixou à origem"). Se todas constam como baixadas, a instância atual fica
 *     indeterminada e o processo é marcado para verificação.
 *   - Valor da causa do processo = o da instância mais baixa informada (o valor
 *     da causa nasce na distribuição). Valor liquidado = o da linha de 1º grau
 *     (a coluna da planilha é "apurado no 1º grau"); sem ela, o primeiro
 *     informado. Vazio continua vazio (RN-03).
 *   - Processo já existente (mesmo CNJ na organização): campos vazios na
 *     planilha nunca apagam dados; processo encerrado não é reaberto; valor
 *     diferente do oficial vigente vira valoração proposta (RN-08); a marcação
 *     de verificação só é ligada (desligar é decisão humana).
 *   - Processo encerrado na planilha sem data de encerramento: usa a data-base
 *     da importação como `closedAt` (alerta `closed_at_assumed`, para conferir),
 *     para não ficar encerrado sem data (prévias e relatório de movimentação).
 *   - Fase e instância são eixos distintos (P0.5): encerramento é a situação,
 *     nunca a fase; a fase vem só dos termos Conhecimento/Liquidação/Execução (da
 *     linha atual ou, na falta, de outra linha do mesmo CNJ). Sem termo de fase:
 *     Conhecimento, com alerta e verificação (`phase_fallback`; quando o texto
 *     só indica a instância, `phase_fallback_instance_only`) ou, se o processo
 *     está encerrado, só informativo (`phase_fallback_closed`). Fase presumida
 *     nunca sobrescreve a fase de um processo existente. Termos recursais acima
 *     da instância da linha atual, sem linha dessa instância, pedem conferência
 *     da instância atual (`forwarded_without_row`); instância deduzida dos termos
 *     recursais (sem célula nem aba de instância) marca o processo para verificação.
 *   - Linhas gravadas antes da P0.5 (lote analisado e confirmado depois) têm a
 *     fase relida do texto da célula (`normalizeStoredPhase`): nenhuma fase do
 *     modelo anterior chega ao banco.
 */
import {
  isProcessPhase,
  type ClosureReason,
  type ImportRowAction,
  type LegalArea,
  type ProcessInstance,
  type ProcessPhase,
  type ProcessStatus,
} from "@/domain/enums";
import type { ImportStats } from "@/server/db/schema/imports";
import {
  formatCentsPlain,
  normalizeKey,
  normalizeStoredPhase,
  type CanonicalField,
  type NormalizedRow,
  type ParsedIssue,
  type ParsedRow,
  type PartyParse,
} from "./parser";

export const INSTANCE_ORDER: readonly ProcessInstance[] = ["first", "second", "superior"];
const INSTANCE_TEXT: Record<ProcessInstance, string> = { first: "1º grau", second: "2º grau", superior: "3º grau" };

export type RowKey = string;
/**
 * Before-state for the rollback of a batch. One recorded before P0.5 may hold a phase of the
 * previous model ("appeal", "closed"...), which can no longer be written (phase and instance are
 * distinct axes): that phase is not restored (the current one is kept); every other field is.
 */
export function withoutLegacyPhase<T extends object>(values: T | null | undefined): T | null {
  if (!values) return null;
  const phase = (values as { phase?: unknown }).phase;
  if (phase === null || phase === undefined || isProcessPhase(phase)) return values;
  const rest: T & { phase?: unknown } = { ...values };
  delete rest.phase;
  return rest;
}

export function rowKey(sheet: string, rowNumber: number): RowKey {
  return `${sheet}\u0000${rowNumber}`;
}

export type PlanRow = Pick<ParsedRow, "sheet" | "rowNumber" | "sheetRole" | "kind" | "error" | "data">;

export type ProcessFieldValues = {
  court: string;
  instance: ProcessInstance | null;
  courtDivision: string | null;
  processClass: string | null;
  city: string | null;
  state: string | null;
  phase: ProcessPhase;
  status: ProcessStatus;
  closureReason: ClosureReason | null;
  closedAt: string | null;
  needsVerification: boolean;
  verificationNote: string | null;
  phaseDetail: string | null;
  companyId: string | null;
  unitId: string | null;
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
};

export type InstanceValues = {
  court: string;
  courtDivision: string | null;
  city: string | null;
  state: string | null;
  processClass: string | null;
  phase: ProcessPhase | null;
  phaseDetail: string | null;
  claimAmountCents: number | null;
  liquidatedAmountCents: number | null;
  isCurrent: boolean;
};

export type ExistingInstance = InstanceValues & { id: string; instance: ProcessInstance };
export type ExistingProcess = ProcessFieldValues & { id: string; number: string; instances: ExistingInstance[] };

export type DivergenceField = "claimAmount" | "liquidatedAmount" | "phase" | "court" | "courtDivision";
export const DIVERGENCE_FIELD_LABELS: Record<DivergenceField, string> = {
  claimAmount: "Valor da causa",
  liquidatedAmount: "Valor liquidado",
  phase: "Fase",
  court: "Tribunal",
  courtDivision: "Vara / órgão julgador",
};

export type DivergenceSide = { sheet: string; row: number; value: string | number | null };
export type Divergence = {
  cnj: string;
  instance: ProcessInstance;
  field: DivergenceField;
  /** Line used as the official base (consolidated sheet when present). */
  base: DivergenceSide;
  other: DivergenceSide;
  /**
   * Money fields: "proposed" = a proposed valuation records the other value in this batch;
   * "existing" = the same value was already recorded for the process (earlier import or entry);
   * "none" = not recorded as a valuation (non-money field, empty value or equal to the official one).
   */
  valuation: "proposed" | "existing" | "none";
};

export type ValuationPlan = {
  kind: "claim" | "liquidated";
  amountCents: number;
  instance: ProcessInstance | null;
  status: "official" | "proposed";
  reason: string;
  rowKey: RowKey;
};

export type InstancePlan = {
  instance: ProcessInstance;
  rowKey: RowKey;
  sheet: string;
  rowNumber: number;
  values: InstanceValues;
  existingId: string | null;
  action: "create" | "update" | "unchanged";
  changes: Partial<InstanceValues>;
  before: Partial<InstanceValues> | null;
};

export type ProcessPlan = {
  cnj: string;
  existingId: string | null;
  action: "create" | "update" | "unchanged";
  primaryRowKey: RowKey;
  target: ProcessFieldValues & { title: string; area: LegalArea; externalSource: string };
  /** Fields to write on an existing process (only what changes). */
  changes: Partial<ProcessFieldValues>;
  before: Partial<ProcessFieldValues> | null;
  /** Official money mirrors of an existing process before the import. */
  inForce: { claimAmountCents: number | null; liquidatedAmountCents: number | null } | null;
  /** Parties for a new process (from the lowest instance line). */
  parties: PartyParse[];
  instances: InstancePlan[];
  /** Existing instance rows (outside the file) that stop being the current instance. */
  clearCurrent: { id: string; before: { isCurrent: boolean } }[];
  valuations: ValuationPlan[];
};

export type RowOutcome = {
  action: ImportRowAction;
  cnj: string | null;
  existingProcessId: string | null;
  /** Issues added by the plan (the parser issues stay on the row). */
  issues: ParsedIssue[];
  divergences: Divergence[];
};

export type ImportPlan = {
  processes: ProcessPlan[];
  outcomes: Map<RowKey, RowOutcome>;
  stats: ImportStats;
  divergences: Divergence[];
};

export type PlanInput = {
  rows: readonly PlanRow[];
  existing: ReadonlyMap<string, ExistingProcess>;
  companyId: string | null;
  defaultUnitId: string | null;
  fileName: string;
  /** process id -> keys "kind:amountCents" of valuations already recorded (any status), for idempotency. */
  existingValuationKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Base date of the import ("YYYY-MM-DD"; the commit date-base, or the one known at
   * analysis). Used as the closing date of a process the spreadsheet marks as closed
   * without a date, so it never ends up `closed` with `closedAt = null`.
   */
  baseDate?: string | null;
};

export const CLOSED_AT_ASSUMED_MESSAGE = "Data de encerramento não informada: usada a data-base da importação; conferir.";

type DataRow = PlanRow & { data: NormalizedRow & { cnj: string; instance: ProcessInstance } };

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeKey(a ?? "") === normalizeKey(b ?? "");
}

function instanceIndex(i: ProcessInstance): number {
  return INSTANCE_ORDER.indexOf(i);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function where(row: PlanRow): string {
  return `${row.sheet} (linha ${row.rowNumber})`;
}

/** "Consolidado Geral, linha 12" (inside parentheses). */
function at(row: PlanRow): string {
  return `${row.sheet}, linha ${row.rowNumber}`;
}

function formatSide(field: DivergenceField, value: string | number | null): string {
  if (field === "claimAmount" || field === "liquidatedAmount") return formatCentsPlain(typeof value === "number" ? value : null);
  return value === null || value === "" ? "vazio" : `"${truncate(String(value), 80)}"`;
}

export function divergenceMessage(d: Divergence): string {
  const label = DIVERGENCE_FIELD_LABELS[d.field];
  return `Divergência entre abas (${label}, ${INSTANCE_TEXT[d.instance]}): ${d.base.sheet} (linha ${d.base.row}) informa ${formatSide(d.field, d.base.value)}; ${d.other.sheet} (linha ${d.other.row}) informa ${formatSide(d.field, d.other.value)}.`;
}

/** Fields compared between the official line and a line of another sheet for the same CNJ + instance. */
function compareRows(base: DataRow, other: DataRow): Divergence[] {
  const out: Divergence[] = [];
  const b = base.data;
  const o = other.data;
  const has = (row: DataRow, f: CanonicalField) => row.data.presentFields.includes(f);
  const push = (field: DivergenceField, bv: string | number | null, ov: string | number | null) =>
    out.push({
      cnj: b.cnj,
      instance: b.instance,
      field,
      base: { sheet: base.sheet, row: base.rowNumber, value: bv },
      other: { sheet: other.sheet, row: other.rowNumber, value: ov },
      valuation: "none",
    });
  if (has(base, "claimAmount") && has(other, "claimAmount") && !sameValue(b.claimAmountCents, o.claimAmountCents)) {
    push("claimAmount", b.claimAmountCents, o.claimAmountCents);
  }
  if (b.hasLiquidatedColumn && o.hasLiquidatedColumn && !sameValue(b.liquidatedAmountCents, o.liquidatedAmountCents)) {
    push("liquidatedAmount", b.liquidatedAmountCents, o.liquidatedAmountCents);
  }
  if (has(base, "phase") && has(other, "phase") && !sameText(b.phase.detail, o.phase.detail)) {
    push("phase", b.phase.detail, o.phase.detail);
  }
  if (has(base, "court") && has(other, "court") && !sameText(b.court, o.court)) push("court", b.court, o.court);
  if (has(base, "courtDivision") && has(other, "courtDivision") && !sameText(b.courtDivision, o.courtDivision)) {
    push("courtDivision", b.courtDivision, o.courtDivision);
  }
  return out;
}

function valuesDiffer(a: DataRow, b: DataRow): boolean {
  return compareRows(a, b).length > 0 || !sameText(a.data.plaintiff?.name, b.data.plaintiff?.name) || !sameText(a.data.defendant?.name, b.data.defendant?.name);
}

const EMPTY_STATS: ImportStats = {
  rowsRead: 0,
  processesDetected: 0,
  toCreate: 0,
  toUpdate: 0,
  unchanged: 0,
  instanceLinks: 0,
  errors: 0,
  warnings: 0,
  duplicatesInSheet: 0,
  divergences: 0,
  ignoredRows: 0,
};

export function buildImportPlan(input: PlanInput): ImportPlan {
  const outcomes = new Map<RowKey, RowOutcome>();
  const outcome = (row: PlanRow, action: ImportRowAction): RowOutcome => {
    const o: RowOutcome = { action, cnj: row.data?.cnj ?? null, existingProcessId: null, issues: [], divergences: [] };
    outcomes.set(rowKey(row.sheet, row.rowNumber), o);
    return o;
  };

  const hasConsolidatedSheet = input.rows.some((r) => r.sheetRole === "consolidated" && r.kind === "data");
  const groups = new Map<string, DataRow[]>();
  let duplicatesInSheet = 0;
  const allDivergences: Divergence[] = [];

  for (const row of input.rows) {
    if (row.kind === "total") {
      outcome(row, "skip");
      continue;
    }
    if (row.error || !row.data?.cnj || !row.data.instance) {
      outcome(row, "error");
      continue;
    }
    const cnj = row.data.cnj;
    if (!groups.has(cnj)) groups.set(cnj, []);
    // A row stored before P0.5 may carry a phase of the previous model: re-read it from the cell text.
    const phase = normalizeStoredPhase(row.data.phase);
    groups.get(cnj)!.push((phase === row.data.phase ? row : { ...row, data: { ...row.data, phase } }) as DataRow);
  }

  const processes: ProcessPlan[] = [];

  for (const [cnj, groupRows] of groups) {
    // Consolidated lines first (they are the official base), then file order.
    const ordered = [...groupRows].sort((a, b) =>
      a.sheetRole === b.sheetRole ? 0 : a.sheetRole === "consolidated" ? -1 : 1,
    );
    const effective = new Map<ProcessInstance, DataRow>();
    const seenSheets = new Map<ProcessInstance, Set<string>>();

    for (const row of ordered) {
      const inst = row.data.instance;
      const eff = effective.get(inst);
      const sheets = seenSheets.get(inst) ?? new Set<string>();
      seenSheets.set(inst, sheets);
      if (!eff) {
        effective.set(inst, row);
        sheets.add(row.sheet);
        continue;
      }
      if (sheets.has(row.sheet)) {
        duplicatesInSheet += 1;
        const o = outcome(row, "skip");
        const firstInSheet = groupRows.find((r) => r.sheet === row.sheet && r.data.instance === inst && r !== row)!;
        o.issues.push({
          level: "warning",
          code: "duplicate_in_sheet",
          field: null,
          message: `Número repetido na mesma aba para o ${INSTANCE_TEXT[inst]} (já na linha ${firstInSheet.rowNumber})${valuesDiffer(firstInSheet, row) ? " com valores diferentes" : ""}: linha ignorada; conferir.`,
        });
        continue;
      }
      sheets.add(row.sheet);
      const divergences = compareRows(eff, row);
      const o = outcome(row, "skip");
      o.issues.push({
        level: "info",
        code: "conferred",
        field: null,
        message: `Linha conferida com ${where(eff)}: os valores oficiais vêm dessa linha.`,
      });
      for (const d of divergences) {
        const msg = divergenceMessage(d);
        o.issues.push({ level: "warning", code: "value_divergence", field: DIVERGENCE_FIELD_LABELS[d.field], message: msg });
        o.divergences.push(d);
        allDivergences.push(d);
      }
    }

    const effRows = INSTANCE_ORDER.map((i) => effective.get(i)).filter((r): r is DataRow => !!r);
    const plan = planProcess(cnj, effRows, input, hasConsolidatedSheet, outcome);
    processes.push(plan);
  }

  // Divergence issues and proposals are attached to the effective (official) line.
  for (const d of allDivergences) {
    const plan = processes.find((p) => p.cnj === d.cnj);
    const inst = plan?.instances.find((i) => i.instance === d.instance);
    if (!plan || !inst) continue;
    const o = outcomes.get(inst.rowKey);
    if (!o) continue;
    o.issues.push({ level: "warning", code: "value_divergence", field: DIVERGENCE_FIELD_LABELS[d.field], message: divergenceMessage(d) });
    o.divergences.push(d);
  }
  for (const plan of processes) addDivergenceProposals(plan, allDivergences, input);

  for (const plan of processes) {
    plan.action = plan.existingId
      ? Object.keys(plan.changes).length > 0 ||
        plan.instances.some((i) => i.action !== "unchanged") ||
        plan.clearCurrent.length > 0 ||
        plan.valuations.length > 0
        ? "update"
        : "unchanged"
      : "create";
    const primary = outcomes.get(plan.primaryRowKey);
    if (primary) primary.action = plan.action;
  }

  const stats: ImportStats = { ...EMPTY_STATS };
  stats.processesDetected = processes.length;
  stats.toCreate = processes.filter((p) => p.action === "create").length;
  stats.toUpdate = processes.filter((p) => p.action === "update").length;
  stats.unchanged = processes.filter((p) => p.action === "unchanged").length;
  stats.duplicatesInSheet = duplicatesInSheet;
  stats.divergences = allDivergences.length;
  for (const row of input.rows) {
    if (row.kind === "data") stats.rowsRead += 1;
    const o = outcomes.get(rowKey(row.sheet, row.rowNumber));
    if (!o) continue;
    if (o.action === "error") stats.errors += 1;
    if (o.action === "skip") stats.ignoredRows += 1;
    if (o.action === "merge_instance") stats.instanceLinks += 1;
  }

  return { processes, outcomes, stats, divergences: allDivergences };
}

/** Counts rows with at least one warning (parser + plan issues). */
export function countWarningRows(rows: readonly { issues: readonly ParsedIssue[] }[]): number {
  return rows.filter((r) => r.issues.some((i) => i.level === "warning")).length;
}

function partyName(p: PartyParse | null, fallback: string): string {
  return p?.name ?? fallback;
}

function planProcess(
  cnj: string,
  effRows: DataRow[],
  input: PlanInput,
  hasConsolidatedSheet: boolean,
  outcome: (row: PlanRow, action: ImportRowAction) => RowOutcome,
): ProcessPlan {
  const existing = input.existing.get(cnj) ?? null;
  const notes: string[] = [];
  const primaryIssues: ParsedIssue[] = [];

  // Current instance: the highest one not marked as returned ("baixou à origem").
  const active = effRows.filter((r) => !r.data.phase.returned);
  const current = active.at(-1) ?? null;
  const highest = effRows.at(-1)!;
  const primary = current ?? highest;
  const baseRow = effRows[0];

  if (!current) {
    const note = `Instância atual não determinada: ${effRows.length === 1 ? "a única instância informada consta" : "todas as instâncias informadas constam"} como baixada(s); conferir.`;
    notes.push(note);
    primaryIssues.push({ level: "warning", code: "current_instance_undetermined", field: null, message: note });
  } else if (current === highest && current.data.phase.forwarded && current.data.instance !== "superior") {
    const note = "A planilha indica remessa à instância superior, mas não há linha dessa instância; conferir a instância atual.";
    notes.push(note);
    primaryIssues.push({ level: "warning", code: "forwarded_without_row", field: null, message: note });
  } else if (
    current === highest &&
    current.data.phase.instance &&
    instanceIndex(current.data.phase.instance) > instanceIndex(current.data.instance)
  ) {
    // P0.5: appeal terms name the instance. A higher instance without a line of its own is not invented: conferir.
    const note = `A fase cita recurso no ${INSTANCE_TEXT[current.data.phase.instance]}, mas não há linha dessa instância; conferir a instância atual.`;
    notes.push(note);
    primaryIssues.push({ level: "warning", code: "forwarded_without_row", field: null, message: note });
  }
  const closedBelow = current ? effRows.filter((r) => instanceIndex(r.data.instance) < instanceIndex(current.data.instance) && r.data.phase.closed) : [];
  if (current && !current.data.phase.closed && closedBelow.length > 0) {
    const note = `${INSTANCE_TEXT[closedBelow[0].data.instance]} consta encerrado, mas o ${INSTANCE_TEXT[current.data.instance]} segue em andamento; conferir.`;
    notes.push(note);
    primaryIssues.push({ level: "warning", code: "instances_contradict", field: null, message: note });
  }
  for (const r of effRows) if (r.data.phase.needsVerification && r.data.phase.verificationNote) notes.push(r.data.phase.verificationNote);
  // An instance read from the appeal terms of the Fase text (no Instância cell or sheet) is a presumption.
  for (const r of effRows) {
    if (r.data.instanceFromPhase) {
      notes.push(`Instância não informada na planilha (${at(r)}): ${INSTANCE_TEXT[r.data.instance]} deduzido dos termos recursais da fase; conferir.`);
    }
  }

  // Phase (P0.5): only conhecimento / liquidação / execução; appeal terms never set it (they name the instance).
  const closed = primary.data.phase.closed;
  let phase: ProcessPhase | null = primary.data.phase.phase;
  if (!phase) {
    phase = [...effRows].reverse().find((r) => r.data.phase.phase)?.data.phase.phase ?? null;
  }
  const phaseFromFile = phase !== null;
  if (!phase) {
    phase = "knowledge";
    if (closed) {
      // Out of the active portfolio: the phase drives no calculation, so no verification is raised.
      primaryIssues.push({
        level: "info",
        code: "phase_fallback_closed",
        field: "Fase",
        message: `Processo encerrado sem fase na planilha ("${truncate(primary.data.phase.detail ?? "vazia", 80)}"): registrado como Conhecimento.`,
      });
    } else {
      // The parser recognized appeal terms as the INSTANCE: the text names no phase (it was not "unrecognized").
      const instanceOnly = [primary, ...effRows].find((r) => r.data.phase.instance)?.data.phase.instance ?? null;
      const note = instanceOnly
        ? `Fase não informada (o texto indica só a instância: ${INSTANCE_TEXT[instanceOnly]}). Registrada como Conhecimento; conferir.`
        : `Fase não reconhecida ("${truncate(primary.data.phase.detail ?? "vazia", 80)}"): registrada como Conhecimento; conferir.`;
      notes.push(note);
      primaryIssues.push({ level: "warning", code: instanceOnly ? "phase_fallback_instance_only" : "phase_fallback", field: "Fase", message: note });
    }
  }
  // A closed process needs a closing date (snapshots and the movement report filter on it).
  const closedAtAssumed = closed && !primary.data.phase.closedAt;
  const closedAt = closed ? (primary.data.phase.closedAt ?? input.baseDate ?? null) : null;

  const located = effRows.find((r) => r.data.city || r.data.state);
  const claimRow = effRows.find((r) => r.data.claimAmountCents !== null) ?? null;
  const claims = new Set(effRows.map((r) => r.data.claimAmountCents).filter((v) => v !== null));
  if (claims.size > 1) {
    primaryIssues.push({
      level: "info",
      code: "instance_values_differ",
      field: "Valor da causa",
      message: `O valor da causa difere entre as instâncias deste número; o processo usa o da instância mais baixa (${where(claimRow!)}). Os demais ficam nos vínculos de instância.`,
    });
  }
  const firstRow = effRows.find((r) => r.data.instance === "first") ?? null;
  const liquidatedRow =
    firstRow && firstRow.data.liquidatedAmountCents !== null
      ? firstRow
      : (effRows.find((r) => r.data.liquidatedAmountCents !== null) ?? null);

  const needsVerification = notes.length > 0;
  const verificationNote = needsVerification ? truncate([...new Set(notes)].join(" · "), 1000) : null;
  const title = truncate(
    `${partyName(baseRow.data.plaintiff, "Parte autora não informada")} x ${partyName(baseRow.data.defendant, "Parte ré não informada")}`,
    200,
  );

  const target: ProcessPlan["target"] = {
    court: primary.data.court!,
    instance: current?.data.instance ?? null,
    courtDivision: primary.data.courtDivision,
    processClass: primary.data.processClass,
    city: located?.data.city ?? null,
    state: located?.data.state ?? null,
    phase,
    status: closed ? "closed" : "active",
    closureReason: closed ? primary.data.phase.closureReason : null,
    closedAt,
    needsVerification,
    verificationNote,
    phaseDetail: primary.data.phase.detail,
    companyId: input.companyId,
    unitId: input.defaultUnitId,
    claimAmountCents: claimRow?.data.claimAmountCents ?? null,
    liquidatedAmountCents: liquidatedRow?.data.liquidatedAmountCents ?? null,
    title,
    area: baseRow.data.area,
    externalSource: truncate(`Planilha ${input.fileName} · ${primary.sheet} linha ${primary.rowNumber}`, 300),
  };

  const parties: PartyParse[] = [baseRow.data.plaintiff, baseRow.data.defendant].filter((p): p is PartyParse => !!p);

  // Instance links
  const instances: InstancePlan[] = effRows.map((r) => {
    const values: InstanceValues = {
      court: r.data.court!,
      courtDivision: r.data.courtDivision,
      city: r.data.city,
      state: r.data.state,
      processClass: r.data.processClass,
      phase: r.data.phase.phase,
      phaseDetail: r.data.phase.detail,
      claimAmountCents: r.data.claimAmountCents,
      liquidatedAmountCents: r.data.liquidatedAmountCents,
      isCurrent: current !== null && r === current,
    };
    const ex = existing?.instances.find((i) => i.instance === r.data.instance) ?? null;
    if (!ex) {
      return { instance: r.data.instance, rowKey: rowKey(r.sheet, r.rowNumber), sheet: r.sheet, rowNumber: r.rowNumber, values, existingId: null, action: "create", changes: {}, before: null };
    }
    const changes: Partial<InstanceValues> = {};
    const before: Partial<InstanceValues> = {};
    for (const key of Object.keys(values) as (keyof InstanceValues)[]) {
      const next = values[key];
      if (key !== "isCurrent" && (next === null || next === undefined)) continue; // blanks never erase data
      // RN-08: a value already informed for the instance is not overwritten (the new one becomes a proposal).
      if ((key === "claimAmountCents" || key === "liquidatedAmountCents") && ex[key] !== null) continue;
      if (!sameValue(ex[key], next)) {
        (changes as Record<string, unknown>)[key] = next;
        (before as Record<string, unknown>)[key] = ex[key];
      }
    }
    const changed = Object.keys(changes).length > 0;
    return {
      instance: r.data.instance,
      rowKey: rowKey(r.sheet, r.rowNumber),
      sheet: r.sheet,
      rowNumber: r.rowNumber,
      values,
      existingId: ex.id,
      action: changed ? "update" : "unchanged",
      changes,
      before: changed ? before : null,
    };
  });

  const clearCurrent =
    existing && current
      ? existing.instances
          .filter((i) => i.isCurrent && !effRows.some((r) => r.data.instance === i.instance))
          .map((i) => ({ id: i.id, before: { isCurrent: true } }))
      : [];

  const valuations: ValuationPlan[] = [];
  const changes: Partial<ProcessFieldValues> = {};
  const before: Partial<ProcessFieldValues> = {};
  const existingKeys = existing ? (input.existingValuationKeys?.get(existing.id) ?? new Set<string>()) : new Set<string>();

  const officialReason = (row: DataRow, kind: "claim" | "liquidated") => {
    if (kind === "liquidated" && row.data.liquidatedAmountCents === 0 && row.data.phase.closureReason === "paid_extinct") {
      return `Quitação: planilha ${input.fileName} indica pago/extinto (${at(row)}).`;
    }
    return `Carga da planilha ${input.fileName} (${at(row)}).`;
  };

  const closedAtIssue: ParsedIssue = { level: "warning", code: "closed_at_assumed", field: "Fase", message: CLOSED_AT_ASSUMED_MESSAGE };

  if (!existing) {
    if (closedAtAssumed) primaryIssues.push(closedAtIssue);
    if (claimRow) {
      valuations.push({ kind: "claim", amountCents: claimRow.data.claimAmountCents!, instance: claimRow.data.instance, status: "official", reason: officialReason(claimRow, "claim"), rowKey: rowKey(claimRow.sheet, claimRow.rowNumber) });
    }
    if (liquidatedRow) {
      valuations.push({ kind: "liquidated", amountCents: liquidatedRow.data.liquidatedAmountCents!, instance: liquidatedRow.data.instance, status: "official", reason: officialReason(liquidatedRow, "liquidated"), rowKey: rowKey(liquidatedRow.sheet, liquidatedRow.rowNumber) });
    }
  } else {
    const set = <K extends keyof ProcessFieldValues>(key: K, value: ProcessFieldValues[K]) => {
      if (value === null || value === undefined) return;
      if (sameValue(existing[key], value)) return;
      changes[key] = value;
      before[key] = existing[key];
    };
    set("court", target.court);
    set("instance", target.instance);
    set("courtDivision", target.courtDivision);
    set("processClass", target.processClass);
    set("city", target.city);
    set("state", target.state);
    set("phaseDetail", target.phaseDetail);
    const existingClosed = existing.status === "closed" || existing.status === "archived";
    if (target.status === "closed") {
      if (!existingClosed) {
        set("status", "closed");
        if (phaseFromFile) set("phase", target.phase);
        set("closureReason", target.closureReason);
        set("closedAt", target.closedAt);
        if (closedAtAssumed) primaryIssues.push(closedAtIssue);
      }
    } else if (existingClosed) {
      primaryIssues.push({
        level: "warning",
        code: "existing_closed_not_reopened",
        field: "Fase",
        message: "Processo encerrado no sistema, mas a planilha o indica em andamento. Não foi reaberto automaticamente; conferir.",
      });
    } else if (phaseFromFile) {
      // A presumed phase (text not recognized) never overwrites the phase already registered.
      set("phase", target.phase);
    }
    if (target.needsVerification && !existing.needsVerification) {
      set("needsVerification", true);
      set("verificationNote", target.verificationNote);
    }
    if (!existing.companyId) set("companyId", target.companyId);
    if (!existing.unitId) set("unitId", target.unitId);

    for (const kind of ["claim", "liquidated"] as const) {
      const row = kind === "claim" ? claimRow : liquidatedRow;
      const field = kind === "claim" ? "claimAmountCents" : "liquidatedAmountCents";
      const value = target[field];
      if (!row || value === null) continue;
      const current = existing[field];
      if (current === null) {
        set(field, value);
        valuations.push({ kind, amountCents: value, instance: row.data.instance, status: "official", reason: officialReason(row, kind), rowKey: rowKey(row.sheet, row.rowNumber) });
      } else if (current !== value) {
        const label = kind === "claim" ? "valor da causa" : "valor liquidado";
        primaryIssues.push({
          level: "warning",
          code: "existing_value_differs",
          field: kind === "claim" ? "Valor da causa" : "Valor liquidado",
          message: `A planilha informa ${label} de ${formatCentsPlain(value)} e o valor oficial vigente é ${formatCentsPlain(current)}: registrado como valor proposto para conferência (não sobrescrito).`,
        });
        if (!existingKeys.has(`${kind}:${value}`)) {
          valuations.push({
            kind,
            amountCents: value,
            instance: row.data.instance,
            status: "proposed",
            reason: `Planilha ${input.fileName} (${at(row)}) informa ${formatCentsPlain(value)}; valor oficial vigente ${formatCentsPlain(current)}.`,
            rowKey: rowKey(row.sheet, row.rowNumber),
          });
        }
      }
    }
  }

  // Row outcomes for the effective lines.
  const primaryKey = rowKey(primary.sheet, primary.rowNumber);
  for (const inst of instances) {
    const row = effRows.find((r) => rowKey(r.sheet, r.rowNumber) === inst.rowKey)!;
    const isPrimary = inst.rowKey === primaryKey;
    const o = outcome(row, isPrimary ? "create" : inst.action === "create" ? "merge_instance" : inst.action);
    o.existingProcessId = existing?.id ?? null;
    if (row.sheetRole === "instance" && hasConsolidatedSheet) {
      o.issues.push({
        level: "info",
        code: "only_in_instance_sheet",
        field: null,
        message: "Número e instância presentes somente nesta aba (não constam da aba consolidada): linha usada como base.",
      });
    }
    if (isPrimary) o.issues.push(...primaryIssues);
  }

  return {
    cnj,
    existingId: existing?.id ?? null,
    action: existing ? "unchanged" : "create",
    primaryRowKey: primaryKey,
    target,
    changes,
    before: Object.keys(before).length > 0 ? before : null,
    inForce: existing ? { claimAmountCents: existing.claimAmountCents, liquidatedAmountCents: existing.liquidatedAmountCents } : null,
    parties,
    instances,
    clearCurrent,
    valuations,
  };
}

/** Money divergences become PROPOSED valuations (RN-08), grouped by amount, never duplicated. */
function addDivergenceProposals(
  plan: ProcessPlan,
  divergences: readonly Divergence[],
  input: PlanInput,
): void {
  const mine = divergences.filter(
    (d) => d.cnj === plan.cnj && (d.field === "claimAmount" || d.field === "liquidatedAmount") && typeof d.other.value === "number",
  );
  if (mine.length === 0) return;
  const existingKeys = plan.existingId ? (input.existingValuationKeys?.get(plan.existingId) ?? new Set<string>()) : new Set<string>();
  const byAmount = new Map<string, Divergence[]>();
  for (const d of mine) {
    const kind = d.field === "claimAmount" ? "claim" : "liquidated";
    const key = `${kind}:${d.other.value}`;
    if (!byAmount.has(key)) byAmount.set(key, []);
    byAmount.get(key)!.push(d);
  }
  for (const [key, list] of byAmount) {
    const [kind, amountText] = key.split(":") as ["claim" | "liquidated", string];
    const amount = Number(amountText);
    const official = kind === "claim" ? plan.target.claimAmountCents : plan.target.liquidatedAmountCents;
    const inForce = plan.inForce ? (kind === "claim" ? plan.inForce.claimAmountCents : plan.inForce.liquidatedAmountCents) : undefined;
    const alreadyPlanned = plan.valuations.some((v) => v.kind === kind && v.amountCents === amount);
    if (existingKeys.has(key)) {
      for (const d of list) d.valuation = "existing";
      continue;
    }
    if (amount === official || amount === inForce || alreadyPlanned) continue;
    const sources = list.map((d) => `${d.other.sheet} (linha ${d.other.row})`).join(" e ");
    const base = list[0].base;
    const instances = new Set(list.map((d) => d.instance));
    plan.valuations.push({
      kind,
      amountCents: amount,
      instance: instances.size === 1 ? list[0].instance : null,
      status: "proposed",
      reason: `Divergência entre abas: ${sources} informa${list.length > 1 ? "m" : ""} ${formatCentsPlain(amount)}; ${base.sheet} (linha ${base.row}) informa ${formatCentsPlain(typeof base.value === "number" ? base.value : null)}.`,
      rowKey: rowKey(base.sheet, base.row),
    });
    for (const d of list) d.valuation = "proposed";
  }
}
