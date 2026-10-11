import path from "node:path";
import { env } from "@/server/env";
import { LocalStorageProvider } from "./local";
import type { StorageProvider } from "./provider";

export {
  assertValidStorageKey,
  buildStorageKey,
  InvalidStorageKeyError,
  StorageObjectNotFoundError,
  type StorageProvider,
} from "./provider";
export { LocalStorageProvider } from "./local";

declare global {
  var __praetorStorage: StorageProvider | undefined;
}

/** Process-wide storage provider (local disk rooted at STORAGE_DIR). */
export function getStorage(): StorageProvider {
  if (!globalThis.__praetorStorage) {
    globalThis.__praetorStorage = new LocalStorageProvider(path.resolve(env().STORAGE_DIR));
  }
  return globalThis.__praetorStorage;
}

/** Tests only: install a provider (or `undefined` to fall back to the default on next use). */
export function setStorageForTesting(provider: StorageProvider | undefined): void {
  globalThis.__praetorStorage = provider;
}

/** The stored object is larger than the caller allows. Permanent (not retried). */
export class StorageReadLimitError extends Error {
  readonly retryable = false;
  constructor() {
    super("Arquivo armazenado maior que o permitido.");
    this.name = "StorageReadLimitError";
  }
}

/** Reads a whole stream into memory, aborting with `StorageReadLimitError` when it exceeds `maxBytes`. */
export async function readStreamToBytes(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new StorageReadLimitError();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
