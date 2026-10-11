/**
 * File storage abstraction. Binary content of document versions lives here;
 * the database only keeps an opaque `storageKey`.
 *
 * Keys are generated server-side only (`buildStorageKey`) as
 * `<orgId>/<documentId>/<versionId>` and never derived from user input
 * (file names are metadata, never paths).
 */
export interface StorageProvider {
  /** Stores the bytes atomically (readers never see a partially written object). */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Opens the object for streaming. Throws `StorageObjectNotFoundError` when it does not exist. */
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;
  /** Removes the object. Missing objects are ignored. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Invalid key (wrong charset, traversal attempt). Programming/security error — never retried. */
export class InvalidStorageKeyError extends Error {
  readonly retryable = false;
  constructor() {
    super("Chave de armazenamento inválida.");
    this.name = "InvalidStorageKeyError";
  }
}

/** The object does not exist. Permanent: the job queue must not retry. */
export class StorageObjectNotFoundError extends Error {
  readonly retryable = false;
  constructor() {
    super("Arquivo não encontrado no armazenamento.");
    this.name = "StorageObjectNotFoundError";
  }
}

const KEY_PATTERN = /^[a-f0-9-]+(\/[a-f0-9-]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validates the charset of a storage key (lower-case hex, dashes and slashes; no empty segments). */
export function assertValidStorageKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.length > 300 || !KEY_PATTERN.test(key)) {
    throw new InvalidStorageKeyError();
  }
}

/** The only way to build a storage key: `<orgId>/<documentId>/<versionId>` (all UUIDs). */
export function buildStorageKey(organizationId: string, documentId: string, versionId: string): string {
  const parts = [organizationId, documentId, versionId].map((p) => p.toLowerCase());
  if (!parts.every((p) => UUID_PATTERN.test(p))) throw new InvalidStorageKeyError();
  return parts.join("/");
}
