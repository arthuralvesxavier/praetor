import { describe, expect, it } from "vitest";
import { bool, int, lines, moneyCents, str, strings } from "./form";
import {
  addDaysISO,
  daysUntil,
  formatDate,
  formatDateTime,
  formatMoneyCents,
  formatRelativeDays,
  maskDocument,
  parseMoneyToCents,
  pluralize,
  todayISO,
} from "./format";
import { safeNextPath } from "./safe-redirect";
import { buildHref, enumParam, pageParam, param } from "./search-params";

const nbsp = (s: string) => s.replace(/ /g, " ");

describe("format", () => {
  it("formats calendar dates without timezone shift", () => {
    expect(formatDate("2026-01-01")).toBe("01/01/2026");
    expect(formatDate("2026-12-31")).toBe("31/12/2026");
    expect(formatDate(null)).toBe("Não informado");
    expect(formatDate("lixo")).toBe("Não informado");
  });

  it("formats timestamps in America/Sao_Paulo", () => {
    expect(formatDateTime(new Date("2026-03-10T02:30:00Z"))).toBe("09/03/2026 23:30");
    expect(formatDate(new Date("2026-03-10T02:30:00Z"))).toBe("09/03/2026");
  });

  it("does calendar arithmetic on ISO dates", () => {
    expect(addDaysISO("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDaysISO("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysUntil("2026-10-14", "2026-10-11")).toBe(3);
    expect(daysUntil("2026-10-09", "2026-10-11")).toBe(-2);
    expect(todayISO(new Date("2026-10-11T02:00:00Z"))).toBe("2026-10-10");
  });

  it("describes relative due dates", () => {
    expect(formatRelativeDays("2026-10-11", "2026-10-11")).toBe("vence hoje");
    expect(formatRelativeDays("2026-10-12", "2026-10-11")).toBe("vence amanhã");
    expect(formatRelativeDays("2026-10-14", "2026-10-11")).toBe("vence em 3 dias");
    expect(formatRelativeDays("2026-10-10", "2026-10-11")).toBe("vencido há 1 dia");
    expect(formatRelativeDays("2026-10-09", "2026-10-11")).toBe("vencido há 2 dias");
  });

  it("formats and parses money", () => {
    expect(nbsp(formatMoneyCents(123456))).toBe("R$ 1.234,56");
    expect(formatMoneyCents(null)).toBe("Não informado");
    expect(parseMoneyToCents("1.234,56")).toBe(123456);
    expect(parseMoneyToCents("R$ 1.234,56")).toBe(123456);
    expect(parseMoneyToCents("1234.56")).toBe(123456);
    expect(parseMoneyToCents("1,234.56")).toBe(123456);
    expect(parseMoneyToCents("1.234")).toBe(123400);
    expect(parseMoneyToCents("1234")).toBe(123400);
    expect(parseMoneyToCents("10,5")).toBe(1050);
    expect(parseMoneyToCents("-5,00")).toBe(-500);
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("1,234")).toBeNull();
    expect(parseMoneyToCents("1,2,3")).toBeNull();
  });

  it("masks CPF and formats CNPJ", () => {
    expect(maskDocument("12345678909")).toBe("***.456.789-**");
    expect(maskDocument("12.345.678/0001-90")).toBe("12.345.678/0001-90");
    expect(maskDocument(null)).toBe("Não informado");
  });

  it("pluralizes", () => {
    expect(pluralize(1, "processo", "processos")).toBe("1 processo");
    expect(pluralize(1234, "processo", "processos")).toBe("1.234 processos");
    expect(pluralize(0, "tarefa", "tarefas", { withCount: false })).toBe("tarefas");
  });
});

describe("form", () => {
  const fd = new FormData();
  fd.set("title", "  Título  ");
  fd.set("empty", "   ");
  fd.set("flag", "on");
  fd.append("tags", "a");
  fd.append("tags", " ");
  fd.append("tags", "b");
  fd.set("n", "42");
  fd.set("bad", "4x");
  fd.set("amount", "1.234,56");
  fd.set("items", "um\n\n dois \r\ntrês");

  it("reads values safely", () => {
    expect(str(fd, "title")).toBe("Título");
    expect(str(fd, "empty")).toBeUndefined();
    expect(bool(fd, "flag")).toBe(true);
    expect(bool(fd, "missing")).toBe(false);
    expect(strings(fd, "tags")).toEqual(["a", "b"]);
    expect(int(fd, "n")).toBe(42);
    expect(int(fd, "bad")).toBeNaN();
    expect(moneyCents(fd, "amount")).toBe(123456);
    expect(moneyCents(fd, "missing")).toBeNull();
    expect(lines(fd, "items")).toEqual(["um", "dois", "três"]);
  });
});

describe("search params", () => {
  const sp = { q: " acme ", status: "active", pagina: "3", vazio: "", multi: ["x", "y"] };

  it("reads params", () => {
    expect(param(sp, "q")).toBe("acme");
    expect(param(sp, "vazio")).toBeUndefined();
    expect(pageParam(sp)).toBe(3);
    expect(pageParam({ pagina: "-1" })).toBe(1);
    expect(pageParam({ pagina: "abc" })).toBe(1);
    expect(enumParam(sp, "status", ["active", "closed"] as const)).toBe("active");
    expect(enumParam({ status: "hack" }, "status", ["active"] as const)).toBeUndefined();
  });

  it("builds hrefs preserving filters", () => {
    expect(buildHref("/processos", sp, { pagina: 4 })).toBe("/processos?q=+acme+&status=active&multi=x&multi=y&pagina=4");
    expect(buildHref("/processos", { status: "active", pagina: "2" }, { pagina: null })).toBe("/processos?status=active");
    expect(buildHref("/processos", {}, {})).toBe("/processos");
  });
});

describe("safeNextPath", () => {
  it("accepts internal paths only", () => {
    expect(safeNextPath("/processos?status=active")).toBe("/processos?status=active");
    expect(safeNextPath("//evil.com")).toBeNull();
    expect(safeNextPath("https://evil.com")).toBeNull();
    expect(safeNextPath("/\\evil.com")).toBeNull();
    expect(safeNextPath("/login")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});
