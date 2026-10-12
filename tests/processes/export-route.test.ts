/**
 * GET /api/processes/export — auth, formats, filters from the URL and the
 * audit entry. The session helper is mocked (no cookies in tests).
 */
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import readXlsxFile from "read-excel-file/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/server/auth/context";
import { auditLogs, legalProcesses } from "@/server/db/schema";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

const session = vi.hoisted(() => ({ current: null as AuthContext | null }));
vi.mock("@/server/auth/session", () => ({ getCurrentUser: async () => session.current }));

const { GET } = await import("@/app/api/processes/export/route");

let f: Fixture;

function request(query: string): NextRequest {
  return { nextUrl: new URL(`http://localhost/api/processes/export?${query}`) } as unknown as NextRequest;
}

beforeAll(async () => {
  f = await setupFixture("exportroute");
  const m = f.ctx.manager;
  const a = await makeProcess(m, { number: "0000201-00.2025.5.10.0001", court: "TRTZ", instance: "first", claimAmountCents: 1_234_56 });
  await makeProcess(m, { number: "0000202-00.2025.5.10.0001", court: "TRTZ", instance: "second" });
  await makeProcess(m, { number: "0000203-00.2025.5.10.0001", court: "OUTRO" });
  await f.db.update(legalProcesses).set({ liquidatedAmountCents: 0 }).where(eq(legalProcesses.id, a));
}, 120_000);

afterAll(async () => {
  await f?.teardown();
});

describe("GET /api/processes/export", () => {
  it("requires a session", async () => {
    session.current = null;
    const res = await GET(request("formato=csv"));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Sessão expirada");
  });

  it("downloads a CSV with BOM, keeping the list filters", async () => {
    session.current = f.ctx.manager;
    const res = await GET(request("tribunal=TRTZ&carteira=todas&formato=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="carteira-processos-\d{4}-\d{2}-\d{2}\.csv"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes.slice(3));
    const lines = text.trimEnd().split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 TRTZ processes
    expect(text).not.toContain("0000203-00.2025.5.10.0001");
    const line = lines.find((l) => l.includes("0000201-00.2025.5.10.0001"))!;
    expect(line).toContain(";1234,56;0,00;");

    const audit = await f.db.select().from(auditLogs).where(eq(auditLogs.action, "legal_process.export"));
    expect(audit.at(-1)?.metadata).toMatchObject({ format: "csv", count: 2, filters: { court: "TRTZ", portfolio: "all" } });
  });

  it("downloads the XLSX workbook", async () => {
    session.current = f.ctx.auditor;
    const res = await GET(request("formato=xlsx&tribunal=TRTZ"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const sheets = await readXlsxFile(buffer);
    expect(sheets.map((s) => s.sheet)).toEqual(["Consolidado Geral", "1º Grau", "2º Grau", "3º Grau"]);
    expect(sheets[0].data).toHaveLength(3);
    expect(sheets[1].data).toHaveLength(2);
    expect(sheets[2].data).toHaveLength(2);
    expect(sheets[3].data).toHaveLength(1); // header only
  });

  it("only exports what the user can see (organization isolation)", async () => {
    session.current = f.ctx.adminB;
    const res = await GET(request("formato=csv&carteira=todas"));
    expect(res.status).toBe(200);
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()).slice(3));
    expect(text.trimEnd().split("\r\n")).toHaveLength(1);
  });
});
