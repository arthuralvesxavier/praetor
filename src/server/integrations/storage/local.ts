import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  assertValidStorageKey,
  InvalidStorageKeyError,
  StorageObjectNotFoundError,
  type StorageProvider,
} from "./provider";

function isNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Stores files on the local disk under `root` (configured by STORAGE_DIR,
 * outside /public). Files are only reachable through the authenticated
 * download route handler.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Resolves a key to an absolute path, guaranteeing it stays inside the root (path traversal guard). */
  resolvePath(key: string): string {
    assertValidStorageKey(key);
    const target = path.resolve(this.root, ...key.split("/"));
    const relative = path.relative(this.root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new InvalidStorageKeyError();
    return target;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.resolvePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    // Atomic write: temp file in the same directory, then rename over the target.
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const target = this.resolvePath(key);
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new StorageObjectNotFoundError();
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError || isNotFound(err)) throw new StorageObjectNotFoundError();
      throw err;
    }
    const nodeStream = createReadStream(target);
    return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> {
    const target = this.resolvePath(key);
    await rm(target, { force: true });
  }

  async exists(key: string): Promise<boolean> {
    const target = this.resolvePath(key);
    try {
      return (await stat(target)).isFile();
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}
