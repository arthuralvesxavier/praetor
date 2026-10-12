import { describe, expect, it } from "vitest";
import {
  BcbSgsClient,
  monthWindows,
  parseSgsResponse,
  SgsError,
  sgsUrl,
  type FetchLike,
} from "@/server/integrations/bcb";
import notFound from "./fixtures/sgs-404-sem-valores.json";
import ipca from "./fixtures/sgs-433-ipca-2024-01-a-2025-06.json";
import selic from "./fixtures/sgs-4390-selic-2026-07-a-2026-10.json";
import tr from "./fixtures/sgs-7811-tr-2025-01-a-2025-06.json";

const HTML_ERROR = "<html><head><title>Requisição inválida!</title></head><body>Bad request</body></html>";

type Reply = { status: number; body: string } | Error;

/** Fake fetch: answers in order and records the URLs (no network). */
function fakeFetch(replies: Reply[]): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    const reply = replies[Math.min(i++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return new Response(reply.body, { status: reply.status, headers: { "Content-Type": "application/json" } });
  };
  return { fetchImpl, urls };
}

const noSleep = async () => {};

describe("SGS parser (real fixtures)", () => {
  it("parses a monthly series keeping the published text, sorted by month", () => {
    const points = parseSgsResponse(ipca);
    expect(points).toHaveLength(18);
    expect(points[0]).toEqual({ month: "2024-01", rate: "0.42" });
    expect(points.find((p) => p.month === "2024-08")).toEqual({ month: "2024-08", rate: "-0.02" });
    expect(points.at(-1)).toEqual({ month: "2025-06", rate: "0.24" });
    expect(parseSgsResponse(tr)[0]).toEqual({ month: "2025-01", rate: "0.1690" });
    expect(parseSgsResponse([...ipca].reverse())[0].month).toBe("2024-01");
  });

  it("rejects daily series, repeated months, unreadable values and wrong shapes", () => {
    const expectInvalid = (json: unknown) => {
      try {
        parseSgsResponse(json);
      } catch (err) {
        expect(err).toBeInstanceOf(SgsError);
        expect((err as SgsError).code).toBe("invalid_response");
        return;
      }
      throw new Error("expected invalid_response");
    };
    expectInvalid({ erro: "x" });
    expectInvalid([{ data: "02/01/2025", dataFim: "02/02/2025", valor: "0.1690" }]);
    expectInvalid([
      { data: "01/01/2025", valor: "0.16" },
      { data: "01/01/2025", valor: "0.17" },
    ]);
    expectInvalid([{ data: "01/01/2025", valor: "0,16" }]);
    expectInvalid([{ data: "2025-01-01", valor: "0.16" }]);
    expectInvalid([{ data: "01/13/2025", valor: "0.16" }]);
  });

  it("builds the documented URL and splits long ranges in windows of 10 years", () => {
    expect(sgsUrl("https://api.bcb.gov.br/", 433, "2024-01", "2024-02")).toBe(
      "https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=01/01/2024&dataFinal=29/02/2024",
    );
    expect(monthWindows("1994-07", "2026-09")).toEqual([
      ["1994-07", "2004-06"],
      ["2004-07", "2014-06"],
      ["2014-07", "2024-06"],
      ["2024-07", "2026-09"],
    ]);
  });
});

describe("BcbSgsClient", () => {
  it("returns the points of the asked range only (the API also returns the current, partial Selic month)", async () => {
    const { fetchImpl, urls } = fakeFetch([{ status: 200, body: JSON.stringify(selic) }]);
    const client = new BcbSgsClient({ fetchImpl, sleep: noSleep });
    const points = await client.fetchMonthly(4390, "2026-07", "2026-09");
    expect(points.map((p) => p.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("bcdata.sgs.4390");
  });

  it('treats the 404 "Value(s) not found" answer as "no new month"', async () => {
    const { fetchImpl } = fakeFetch([{ status: 404, body: JSON.stringify(notFound) }]);
    const client = new BcbSgsClient({ fetchImpl, sleep: noSleep });
    await expect(client.fetchMonthly(433, "2030-01", "2030-12")).resolves.toEqual([]);
  });

  it("retries the HTML error page, 5xx and network failures, then succeeds", async () => {
    const { fetchImpl, urls } = fakeFetch([
      { status: 200, body: HTML_ERROR },
      { status: 503, body: "" },
      { status: 200, body: JSON.stringify(ipca) },
    ]);
    const delays: number[] = [];
    const client = new BcbSgsClient({ fetchImpl, attempts: 3, backoffBaseMs: 10, sleep: async (ms) => void delays.push(ms) });
    const points = await client.fetchMonthly(433, "2024-01", "2024-12");
    expect(points).toHaveLength(12);
    expect(urls).toHaveLength(3);
    expect(delays).toEqual([10, 20]);
  });

  it("gives up after the attempts with a message that never carries the response body", async () => {
    const { fetchImpl, urls } = fakeFetch([new TypeError("fetch failed")]);
    const client = new BcbSgsClient({ fetchImpl, attempts: 2, sleep: noSleep });
    const err = await client.fetchMonthly(433, "2024-01", "2024-12").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SgsError);
    expect((err as SgsError).code).toBe("network");
    expect((err as SgsError).message).toBe("Falha de comunicação com o Banco Central (TypeError).");
    expect(urls).toHaveLength(2);
  });

  it("does not retry a refused request (4xx other than 404/429)", async () => {
    const { fetchImpl, urls } = fakeFetch([{ status: 400, body: JSON.stringify({ erro: { statusCode: 400 } }) }]);
    const client = new BcbSgsClient({ fetchImpl, attempts: 3, sleep: noSleep });
    const err = await client.fetchMonthly(433, "2024-01", "2024-12").catch((e: unknown) => e);
    expect((err as SgsError).code).toBe("http_error");
    expect((err as SgsError).message).not.toContain("statusCode");
    expect(urls).toHaveLength(1);
  });

  it("requests one window per 10 years", async () => {
    const { fetchImpl, urls } = fakeFetch([{ status: 404, body: JSON.stringify(notFound) }]);
    const client = new BcbSgsClient({ fetchImpl, sleep: noSleep });
    await client.fetchMonthly(188, "1994-07", "2026-09");
    expect(urls).toHaveLength(4);
    expect(urls[0]).toContain("dataInicial=01/07/1994&dataFinal=30/06/2004");
    expect(urls[3]).toContain("dataInicial=01/07/2024&dataFinal=30/09/2026");
  });
});
