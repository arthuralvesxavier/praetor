/**
 * Court data collection (DataJud / CNJ public API). Normalized shapes shared by
 * the providers and the court-sync module.
 *
 * Only fields the DataJud public API really returns are modeled (verified on
 * 2026-10-11): there are NO parties, NO valor da causa and NO documents, and a
 * hearing movement says whether a hearing was designated/held/cancelled but
 * NOT its date. Nothing here is ever invented or completed by guess.
 */

/** Additional tabulated data of a movement (`complementosTabelados`). */
export type CourtMovementComplement = {
  code: number | null;
  /** Technical key, e.g. "situacao_da_audiencia", "motivo_da_remessa". */
  description: string;
  value: number | string | null;
  /** Human value, e.g. "designada", "em grau de recurso". */
  name: string;
};

export type CourtMovement = {
  /** CNJ movement code (Tabela Processual Unificada) as informed; null when absent. */
  code: number | null;
  name: string;
  /** Timestamp exactly as informed by the tribunal (ISO string). */
  dateTime: string;
  complements: CourtMovementComplement[];
  /** Órgão julgador of the movement, when informed. */
  courtDivision: string | null;
};

export type CourtSubject = { code: number; name: string };

/** One document of the DataJud index = one number in one grau of one tribunal. */
export type CourtRecord = {
  source: "datajud";
  /** Endpoint alias that returned it ("trt10", "tst", "tjsp"...). */
  alias: string;
  /** Tribunal acronym as informed ("TRT10", "TST"...). */
  tribunal: string;
  /** Grau as informed: "G1", "G2", "SUP" (others are kept but not mapped to an instance). */
  grau: string;
  /** 20 digits. */
  number: string;
  /** Filing date (YYYY-MM-DD) as informed; null when absent or unreadable. */
  filedAt: string | null;
  secrecyLevel: number | null;
  courtDivision: { code: number | null; name: string; ibgeCode: number | null } | null;
  processClass: { code: number | null; name: string } | null;
  system: string | null;
  format: string | null;
  /** `dataHoraUltimaAtualizacao` (ISO) when informed. */
  remoteUpdatedAt: string | null;
  subjects: CourtSubject[];
  /** Sorted by `dateTime` (oldest first). Duplicates are kept as informed. */
  movements: CourtMovement[];
};

export type CourtSearchOptions = {
  /** Requests per minute allowed for this alias (per-tribunal rate limit). */
  maxRequestsPerMinute?: number;
  /** Total attempts (1 = no retry). */
  attempts?: number;
  timeoutMs?: number;
};

/** Provider of official court data. Implementations: DataJudProvider (real), FakeCourtProvider (tests). */
export interface CourtDataProvider {
  readonly name: string;
  /** Batch lookup of 20-digit numbers in one endpoint alias. Returns every grau found. */
  searchByNumbers(alias: string, numbers: string[], opts?: CourtSearchOptions): Promise<CourtRecord[]>;
}

export type CourtProviderErrorCode =
  | "timeout"
  | "network"
  | "rate_limited"
  | "server_error"
  | "unauthorized"
  | "unknown_alias"
  | "bad_request"
  | "invalid_response";

/**
 * Failure of a court provider. `message` is a sanitized pt-BR text that never
 * contains response bodies, query parameters or keys.
 */
export class CourtProviderError extends Error {
  constructor(
    readonly code: CourtProviderErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "CourtProviderError";
  }
}
