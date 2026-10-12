import { CourtProviderError, type CourtDataProvider, type CourtRecord, type CourtSearchOptions } from "./types";

/**
 * In-memory court provider for tests (never used by the application). Records
 * are registered per alias; every call is recorded so tests can assert the
 * batching (one query per alias with many numbers).
 */
export class FakeCourtProvider implements CourtDataProvider {
  readonly name = "Fonte de teste";
  readonly calls: { alias: string; numbers: string[]; opts: CourtSearchOptions }[] = [];
  private readonly records = new Map<string, CourtRecord[]>();
  private readonly failures = new Map<string, CourtProviderError>();

  /** Adds records answered by `alias` (each record's `number` must be 20 digits). */
  add(alias: string, ...records: CourtRecord[]): this {
    this.records.set(alias, [...(this.records.get(alias) ?? []), ...records]);
    return this;
  }

  /** Replaces every record of `alias`. */
  set(alias: string, records: CourtRecord[]): this {
    this.records.set(alias, [...records]);
    return this;
  }

  /** Changes the matching records of `alias` (a tribunal updating its data). */
  update(alias: string, match: (r: CourtRecord) => boolean, change: (r: CourtRecord) => CourtRecord): this {
    this.records.set(
      alias,
      (this.records.get(alias) ?? []).map((r) => (match(r) ? change(structuredClone(r)) : r)),
    );
    return this;
  }

  /** Makes every call to `alias` fail with `error` (null clears it). */
  fail(alias: string, error: CourtProviderError | null): this {
    if (error) this.failures.set(alias, error);
    else this.failures.delete(alias);
    return this;
  }

  async searchByNumbers(alias: string, numbers: string[], opts: CourtSearchOptions = {}): Promise<CourtRecord[]> {
    this.calls.push({ alias, numbers: [...numbers], opts });
    const failure = this.failures.get(alias);
    if (failure) throw failure;
    const wanted = new Set(numbers);
    return (this.records.get(alias) ?? []).filter((r) => wanted.has(r.number)).map((r) => structuredClone(r));
  }
}
