import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertValidStorageKey,
  buildStorageKey,
  InvalidStorageKeyError,
  LocalStorageProvider,
  readStreamToBytes,
  StorageObjectNotFoundError,
  StorageReadLimitError,
} from "@/server/integrations/storage";

const ORG = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
const VER = "33333333-3333-4333-8333-333333333333";

let root: string;
let storage: LocalStorageProvider;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "praetor-storage-"));
  storage = new LocalStorageProvider(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("storage keys", () => {
  it("builds keys only from UUIDs", () => {
    expect(buildStorageKey(ORG, DOC, VER)).toBe(`${ORG}/${DOC}/${VER}`);
    expect(buildStorageKey(ORG.toUpperCase(), DOC, VER)).toBe(`${ORG}/${DOC}/${VER}`);
    expect(() => buildStorageKey(ORG, "../x", VER)).toThrow(InvalidStorageKeyError);
    expect(() => buildStorageKey(ORG, DOC, "abc")).toThrow(InvalidStorageKeyError);
  });

  it.each([
    "../etc/passwd",
    "a/../../b",
    "/abs/path",
    "C:\\Windows\\win.ini",
    "a//b",
    "a/b/",
    "",
    "ABC",
    "a/./b",
    "a\u0000b",
    "..",
  ])("rejects invalid key %j", (key) => {
    expect(() => assertValidStorageKey(key)).toThrow(InvalidStorageKeyError);
    expect(() => storage.resolvePath(key)).toThrow(InvalidStorageKeyError);
  });

  it("resolves valid keys inside the root", () => {
    const resolved = storage.resolvePath(`${ORG}/${DOC}/${VER}`);
    expect(path.relative(root, resolved).startsWith("..")).toBe(false);
    expect(resolved.startsWith(path.resolve(root))).toBe(true);
  });
});

describe("LocalStorageProvider", () => {
  it("round-trips bytes atomically and deletes them", async () => {
    const key = buildStorageKey(ORG, DOC, VER);
    const bytes = new TextEncoder().encode("conteúdo de teste");
    expect(await storage.exists(key)).toBe(false);
    await storage.put(key, bytes);
    expect(await storage.exists(key)).toBe(true);

    // No temp files left behind.
    const dir = path.dirname(storage.resolvePath(key));
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(new Uint8Array(await readFile(storage.resolvePath(key)))).toEqual(bytes);

    const back = await readStreamToBytes(await storage.getStream(key), 1024);
    expect(new TextDecoder().decode(back)).toBe("conteúdo de teste");

    await expect(readStreamToBytes(await storage.getStream(key), 4)).rejects.toBeInstanceOf(StorageReadLimitError);

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    await storage.delete(key); // idempotent
  });

  it("throws StorageObjectNotFoundError for missing objects", async () => {
    const key = buildStorageKey(ORG, DOC, "44444444-4444-4444-8444-444444444444");
    await expect(storage.getStream(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });
});
