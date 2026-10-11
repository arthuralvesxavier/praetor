import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/server/lib/logger";

afterEach(() => vi.restoreAllMocks());

function captureWarn(): () => string {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
  return () => lines.join("\n");
}

describe("logger redaction of database errors", () => {
  it("drops the message (with bound parameters) of a DrizzleQueryError, keeping name and SQLSTATE", () => {
    const output = captureWarn();
    const cause = Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: "23505", severity: "ERROR" });
    const err = Object.assign(new Error("Failed query: insert into documents ... params: SEGREDO-CONFIDENCIAL"), {
      name: "DrizzleQueryError",
      cause,
    });
    err.name = "DrizzleQueryError";
    logger.warn("test.db_error", { error: err });
    const line = output();
    expect(line).not.toContain("SEGREDO-CONFIDENCIAL");
    expect(line).toContain("DrizzleQueryError");
    expect(line).toContain("23505");
  });

  it("drops the message of raw driver errors too", () => {
    const output = captureWarn();
    const err = Object.assign(new Error('invalid input syntax for type uuid: "SEGREDO"'), { code: "22P02", severity: "ERROR" });
    logger.error("test.driver_error", { error: err });
    expect(output()).not.toContain("SEGREDO");
  });

  it("keeps the (truncated) message of ordinary errors", () => {
    const output = captureWarn();
    logger.warn("test.other_error", { error: new Error("timeout talking to provider") });
    expect(output()).toContain("timeout talking to provider");
  });
});
