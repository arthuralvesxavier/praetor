import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 30_000,
    // PGlite boots a WASM PostgreSQL and applies every migration; during a full
    // parallel run on a loaded machine this can take well over a minute.
    hookTimeout: 120_000,
    pool: "forks",
  },
});
