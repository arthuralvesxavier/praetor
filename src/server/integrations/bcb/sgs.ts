import { logger } from "@/server/lib/logger";

/**
 * Banco Central do Brasil, SGS public data API (no key required).
 *
 *   GET {baseUrl}/dados/serie/bcdata.sgs.{code}/dados?formato=json&dataInicial=dd/MM/aaaa&dataFinal=dd/MM/aaaa
 *   200 → [{"data":"01/09/2026","valor":"0.48"}, ...]   (monthly series: day is always 01)
 *   404 → {"erro":{"statusCode":404,"detail":"...Value(s) not found"}}   (no value in the range)
 *
 * Observed behavior (2026-10-12): the gateway sometimes answers with an HTML
 * "Requisição inválida" page (treated as a retryable invalid response); the
 * Selic accumulated in the month (4390) already returns the CURRENT, partial
 * month (the caller never stores the current month). Long ranges are split in
 * windows of at most 10 years. Timeouts, 429, 5xx and non-JSON answers are
 * retried with exponential backoff. Error messages never carry response bodies.
 */

export type SgsMonthlyPoint = {
  /** "YYYY-MM". */
  month: string;
  /** Monthly variation exactly as published, dot decimal ("0.16", "-0.32", "0.1690"). */
  rate: string;
};

export type SgsErrorCode = "network" | "timeout" | "rate_limited" | "server_error" | "invalid_response" | "http_error";

export class SgsError extends Error {
  constructor(
    readonly code: SgsErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "SgsError";
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export interface SgsClient {
  readonly name: string;
  /** Monthly points of the series between two months (inclusive), sorted by month. */
  fetchMonthly(sgsCode: number, fromMonth: string, toMonth: string): Promise<SgsMonthlyPoint[]>;
}

export type BcbSgsClientOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  /** Attempts per request (1–6). */
  attempts?: number;
  /** First retry delay (doubles each attempt). */
  backoffBaseMs?: number;
  fetchImpl?: FetchLike;
  sleep?: Sleep;
};

export const BCB_SGS_BASE_URL = "https://api.bcb.gov.br";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 3;
/** The API refuses very long ranges for some series; 10 years per request is safe. */
export const SGS_MAX_MONTHS_PER_REQUEST = 120;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** Plain decimal with a dot, as published by the SGS ("0.16", "-0.32", "0.1690"). */
const RATE_TEXT_RE = /^-?\d{1,6}(\.\d{1,6})?$/;

function isMonth(value: string): boolean {
  return MONTH_RE.test(value);
}

function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function lastDayOfMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** URL of one request (first day of `fromMonth` to the last day of `toMonth`). */
export function sgsUrl(baseUrl: string, sgsCode: number, fromMonth: string, toMonth: string): string {
  const [fy, fm] = fromMonth.split("-");
  const [ty, tm] = toMonth.split("-");
  const last = String(lastDayOfMonth(toMonth)).padStart(2, "0");
  const query = `formato=json&dataInicial=01/${fm}/${fy}&dataFinal=${last}/${tm}/${ty}`;
  return `${baseUrl.replace(/\/+$/, "")}/dados/serie/bcdata.sgs.${sgsCode}/dados?${query}`;
}

/** Splits an inclusive month range into windows of at most `size` months. */
export function monthWindows(fromMonth: string, toMonth: string, size = SGS_MAX_MONTHS_PER_REQUEST): [string, string][] {
  const out: [string, string][] = [];
  for (let start = fromMonth; start <= toMonth; start = addMonths(start, size)) {
    const end = addMonths(start, size - 1);
    out.push([start, end < toMonth ? end : toMonth]);
  }
  return out;
}

const SGS_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function invalid(detail: string): SgsError {
  return new SgsError("invalid_response", `Resposta do Banco Central em formato inesperado (${detail}).`, false);
}

/**
 * Parses the JSON body of a monthly series. Throws `SgsError("invalid_response")`
 * on anything unexpected (wrong shape, a day other than 01, which means the
 * code is not a monthly series, an unreadable rate or a repeated month).
 */
export function parseSgsResponse(json: unknown): SgsMonthlyPoint[] {
  if (!Array.isArray(json)) throw invalid("não é uma lista");
  const seen = new Set<string>();
  const points: SgsMonthlyPoint[] = [];
  for (const item of json) {
    if (!item || typeof item !== "object") throw invalid("item inválido");
    const { data, valor } = item as { data?: unknown; valor?: unknown };
    const date = typeof data === "string" ? SGS_DATE_RE.exec(data.trim()) : null;
    if (!date) throw invalid("data inválida");
    if (date[1] !== "01") throw invalid("a série não é mensal");
    const month = `${date[3]}-${date[2]}`;
    if (!isMonth(month)) throw invalid("mês inválido");
    if (seen.has(month)) throw invalid(`mês repetido ${date[2]}/${date[3]}`);
    const rate = typeof valor === "string" ? valor.trim() : "";
    if (!RATE_TEXT_RE.test(rate)) throw invalid(`valor ilegível em ${date[2]}/${date[3]}`);
    seen.add(month);
    points.push({ month, rate });
  }
  return points.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

/** `{"erro":{"statusCode":404,...}}`: the API's answer for "no value in the range". */
function isNoValuesBody(json: unknown): boolean {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const erro = (json as { erro?: { statusCode?: unknown } }).erro;
  return !!erro && typeof erro === "object" && Number(erro.statusCode) === 404;
}

export class BcbSgsClient implements SgsClient {
  readonly name = "Banco Central do Brasil (SGS)";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly backoffBaseMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;

  constructor(opts: BcbSgsClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? BCB_SGS_BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attempts = Math.max(1, Math.min(6, opts.attempts ?? DEFAULT_ATTEMPTS));
    this.backoffBaseMs = opts.backoffBaseMs ?? 2_000;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? realSleep;
  }

  async fetchMonthly(sgsCode: number, fromMonth: string, toMonth: string): Promise<SgsMonthlyPoint[]> {
    if (!Number.isInteger(sgsCode) || sgsCode <= 0) throw new SgsError("http_error", "Código de série inválido.", false);
    if (!isMonth(fromMonth) || !isMonth(toMonth) || fromMonth > toMonth) return [];
    const all: SgsMonthlyPoint[] = [];
    for (const [from, to] of monthWindows(fromMonth, toMonth)) {
      const points = await this.withRetries(sgsCode, () => this.request(sgsCode, from, to));
      for (const p of points) if (p.month >= from && p.month <= to) all.push(p);
    }
    return all;
  }

  private async withRetries<T>(sgsCode: number, fn: () => Promise<T>): Promise<T> {
    let lastError: SgsError | null = null;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const error = err instanceof SgsError ? err : new SgsError("network", "Falha de comunicação com o Banco Central.", true);
        lastError = error;
        logger.warn("bcb_sgs_request_failed", { sgsCode, attempt, code: error.code, httpStatus: error.httpStatus });
        if (!error.retryable || attempt === this.attempts) break;
        await this.sleep(this.backoffBaseMs * 2 ** (attempt - 1));
      }
    }
    throw lastError ?? new SgsError("network", "Falha de comunicação com o Banco Central.", true);
  }

  private async request(sgsCode: number, fromMonth: string, toMonth: string): Promise<SgsMonthlyPoint[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(sgsUrl(this.baseUrl, sgsCode, fromMonth, toMonth), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
        cache: "no-store",
      });
      text = await response.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new SgsError("timeout", `O Banco Central não respondeu em ${Math.round(this.timeoutMs / 1000)} s.`, true);
      }
      throw new SgsError("network", `Falha de comunicação com o Banco Central (${(err as Error)?.name ?? "erro"}).`, true);
    } finally {
      clearTimeout(timer);
    }

    let json: unknown;
    let isJson = true;
    try {
      json = JSON.parse(text);
    } catch {
      isJson = false;
    }

    if (response.status === 404 && isJson && isNoValuesBody(json)) return [];
    if (response.status === 429) {
      throw new SgsError("rate_limited", "O Banco Central limitou as consultas (muitas requisições).", true, 429);
    }
    if (response.status >= 500) {
      throw new SgsError("server_error", `O Banco Central está indisponível no momento (HTTP ${response.status}).`, true, response.status);
    }
    if (!isJson) {
      // The gateway answers some requests with an HTML error page: try again.
      throw new SgsError("invalid_response", "Resposta do Banco Central em formato inesperado (não é JSON).", true, response.status);
    }
    if (!response.ok) {
      throw new SgsError("http_error", `O Banco Central recusou a consulta (HTTP ${response.status}).`, false, response.status);
    }
    return parseSgsResponse(json);
  }
}
