import { logger } from "@/server/lib/logger";
import { SlidingWindowLimiter, realSleep, type Clock, type Sleep } from "./rate-limit";
import {
  CourtProviderError,
  type CourtDataProvider,
  type CourtMovement,
  type CourtMovementComplement,
  type CourtRecord,
  type CourtSearchOptions,
  type CourtSubject,
} from "./types";

/**
 * DataJud (CNJ) public API provider.
 *
 *   POST {baseUrl}/api_publica_<alias>/_search
 *   Authorization: APIKey <public key published by the CNJ>
 *   {"size": n, "query": {"terms": {"numeroProcesso": ["<20 digits>", ...]}}}
 *
 * The same number returns one document per grau ("G1", "G2" in the TRT index,
 * "SUP" in the TST index). Queries commonly take 7 to 25 s. Each alias has its
 * own rate limit (sliding window per minute); timeouts, 429 and 5xx are
 * retried with exponential backoff. Error messages never carry response
 * bodies, keys or query parameters.
 */

const DEFAULT_MAX_PER_MINUTE = 20;
const DEFAULT_ATTEMPTS = 3;
const MAX_NUMBERS_PER_QUERY = 500;
const ALIAS_PATTERN = /^[a-z0-9-]{2,12}$/;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type DataJudProviderOptions = {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  limiter?: SlidingWindowLimiter;
  sleep?: Sleep;
  now?: Clock;
  /** First retry delay (doubles each attempt). */
  backoffBaseMs?: number;
};

/** Process-wide limiter: every DataJudProvider instance shares the per-alias windows. */
const sharedLimiter = new SlidingWindowLimiter();

export class DataJudProvider implements CourtDataProvider {
  readonly name = "DataJud (CNJ)";
  private readonly fetchImpl: FetchLike;
  private readonly limiter: SlidingWindowLimiter;
  private readonly sleep: Sleep;
  private readonly backoffBaseMs: number;

  constructor(private readonly opts: DataJudProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.limiter = opts.limiter ?? sharedLimiter;
    this.sleep = opts.sleep ?? realSleep;
    this.backoffBaseMs = opts.backoffBaseMs ?? 2_000;
  }

  async searchByNumbers(alias: string, numbers: string[], options: CourtSearchOptions = {}): Promise<CourtRecord[]> {
    if (!ALIAS_PATTERN.test(alias)) throw new CourtProviderError("unknown_alias", "Tribunal sem consulta no DataJud.", false);
    const unique = [...new Set(numbers.filter((n) => /^\d{20}$/.test(n)))].slice(0, MAX_NUMBERS_PER_QUERY);
    if (unique.length === 0) return [];
    const attempts = Math.max(1, Math.min(6, options.attempts ?? DEFAULT_ATTEMPTS));
    const maxPerMinute = options.maxRequestsPerMinute ?? DEFAULT_MAX_PER_MINUTE;
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;

    let lastError: CourtProviderError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.limiter.acquire(alias, maxPerMinute);
      try {
        return await this.request(alias, unique, timeoutMs);
      } catch (err) {
        const error =
          err instanceof CourtProviderError ? err : new CourtProviderError("network", "Falha de comunicação com o DataJud.", true);
        lastError = error;
        logger.warn("datajud_request_failed", { alias, attempt, code: error.code, httpStatus: error.httpStatus });
        if (!error.retryable || attempt === attempts) break;
        await this.sleep(this.backoffBaseMs * 2 ** (attempt - 1));
      }
    }
    throw lastError ?? new CourtProviderError("network", "Falha de comunicação com o DataJud.", true);
  }

  private async request(alias: string, numbers: string[], timeoutMs: number): Promise<CourtRecord[]> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/api_publica_${alias}/_search`;
    const body = JSON.stringify({
      size: Math.min(10_000, numbers.length * 5),
      query: { terms: { numeroProcesso: numbers } },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `APIKey ${this.opts.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new CourtProviderError("timeout", `O DataJud não respondeu em ${Math.round(timeoutMs / 1000)} s.`, true);
      }
      throw new CourtProviderError("network", `Falha de comunicação com o DataJud (${(err as Error)?.name ?? "erro"}).`, true);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw errorForStatus(response.status);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new CourtProviderError("invalid_response", "Resposta do DataJud em formato inesperado.", true, response.status);
    }
    return parseDataJudResponse(alias, json);
  }
}

function errorForStatus(status: number): CourtProviderError {
  if (status === 401 || status === 403) {
    return new CourtProviderError(
      "unauthorized",
      "O DataJud recusou a chave de acesso (o CNJ pode ter trocado a chave pública: atualize DATAJUD_API_KEY).",
      false,
      status,
    );
  }
  if (status === 404) return new CourtProviderError("unknown_alias", "Tribunal sem consulta no DataJud (endpoint inexistente).", false, status);
  if (status === 429) return new CourtProviderError("rate_limited", "O DataJud limitou as consultas (muitas requisições).", true, status);
  if (status >= 500) return new CourtProviderError("server_error", `O DataJud está indisponível no momento (HTTP ${status}).`, true, status);
  return new CourtProviderError("bad_request", `O DataJud recusou a consulta (HTTP ${status}).`, false, status);
}

// ---------------------------------------------------------------------------
// Normalization (pure; unit-tested with a recorded fixture)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** "20250228223933" / "20250228" / ISO -> "YYYY-MM-DD" (calendar date as informed, no time zone shift). */
export function parseDataJudDate(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{6})?$/.exec(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  const m = compact ?? iso;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** ISO timestamp with any number of fractional digits -> canonical ISO, or null. */
export function parseDataJudTimestamp(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const normalized = s.replace(/(\.\d{3})\d+/, "$1");
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function normalizeComplements(value: unknown): CourtMovementComplement[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((c) => ({
    code: num(c.codigo),
    description: str(c.descricao) ?? "",
    value: typeof c.valor === "number" || typeof c.valor === "string" ? c.valor : null,
    name: str(c.nome) ?? "",
  }));
}

function normalizeMovement(value: Json): CourtMovement | null {
  const dateTime = str(value.dataHora);
  if (!dateTime) return null;
  const code = num(value.codigo);
  const division = isObject(value.orgaoJulgador) ? str(value.orgaoJulgador.nome) : null;
  return {
    code,
    name: str(value.nome) ?? (code !== null ? `Movimentação sem nome (código ${code})` : "Movimentação sem nome"),
    dateTime,
    complements: normalizeComplements(value.complementosTabelados),
    courtDivision: division,
  };
}

function normalizeSubjects(value: unknown): CourtSubject[] {
  if (!Array.isArray(value)) return [];
  const out: CourtSubject[] = [];
  for (const raw of value) {
    // Some tribunals nest a list per subject; flatten one level.
    const items = Array.isArray(raw) ? raw : [raw];
    for (const s of items) {
      if (!isObject(s)) continue;
      const code = num(s.codigo);
      const name = str(s.nome);
      if (code === null || !name) continue;
      out.push({ code, name: name.replace(/\s+/g, " ") });
    }
  }
  return out;
}

/** One `_source` document -> CourtRecord (null when it lacks the number or the grau). */
export function normalizeDataJudSource(alias: string, source: unknown): CourtRecord | null {
  if (!isObject(source)) return null;
  const number = str(source.numeroProcesso)?.replace(/\D/g, "") ?? "";
  const grau = str(source.grau);
  if (number.length !== 20 || !grau) return null;
  const division = isObject(source.orgaoJulgador)
    ? {
        code: num(source.orgaoJulgador.codigo),
        name: str(source.orgaoJulgador.nome) ?? "",
        ibgeCode: num(source.orgaoJulgador.codigoMunicipioIBGE),
      }
    : null;
  const processClass = isObject(source.classe) ? { code: num(source.classe.codigo), name: str(source.classe.nome) ?? "" } : null;
  const movements = (Array.isArray(source.movimentos) ? source.movimentos : [])
    .filter(isObject)
    .map(normalizeMovement)
    .filter((m): m is CourtMovement => m !== null)
    .sort((a, b) => (a.dateTime < b.dateTime ? -1 : a.dateTime > b.dateTime ? 1 : 0));
  return {
    source: "datajud",
    alias,
    tribunal: (str(source.tribunal) ?? alias).toUpperCase(),
    grau: grau.toUpperCase(),
    number,
    filedAt: parseDataJudDate(source.dataAjuizamento),
    secrecyLevel: num(source.nivelSigilo),
    courtDivision: division && division.name ? division : null,
    processClass: processClass && processClass.name ? processClass : null,
    system: isObject(source.sistema) ? str(source.sistema.nome) : null,
    format: isObject(source.formato) ? str(source.formato.nome) : null,
    remoteUpdatedAt: parseDataJudTimestamp(source.dataHoraUltimaAtualizacao),
    subjects: normalizeSubjects(source.assuntos),
    movements,
  };
}

/** Elasticsearch `_search` response -> records (unknown shapes are rejected, never guessed). */
export function parseDataJudResponse(alias: string, json: unknown): CourtRecord[] {
  if (!isObject(json) || !isObject(json.hits) || !Array.isArray(json.hits.hits)) {
    throw new CourtProviderError("invalid_response", "Resposta do DataJud em formato inesperado.", true);
  }
  const out: CourtRecord[] = [];
  for (const hit of json.hits.hits) {
    if (!isObject(hit)) continue;
    const record = normalizeDataJudSource(alias, hit._source);
    if (record) out.push(record);
  }
  return out;
}
