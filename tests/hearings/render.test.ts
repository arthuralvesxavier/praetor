import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { addDaysISO, todayISO } from "@/lib/format";
import { upsertAlert, listAlerts } from "@/modules/alerts/service";
import { AlertRows } from "@/modules/alerts/components/alert-list";
import { ProcessHearingsTab } from "@/modules/hearings/components/process-hearings-tab";
import { createHearing, listHearings } from "@/modules/hearings/service";
import { HearingRow } from "@/modules/hearings/components/hearing-row";
import { WorkCalendar } from "@/modules/work/components/work-calendar";
import { listCalendarItems } from "@/modules/work/service";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

/**
 * Server-render smoke tests of the hearings / alerts / calendar UI with real
 * data (no browser): catches runtime errors and checks the pt-BR labels that
 * the business rules require (simulation, no court integration, hearing label).
 */

// Components import their server actions (which import the session helpers): stub the Next-only guards.
vi.mock("server-only", () => ({}));

let fx: Fixture;
const ids: Record<string, string> = {};
const today = todayISO();

beforeAll(async () => {
  fx = await setupFixture("hrender");
  ids.p = await makeProcess(fx.ctx.admin, { unitId: fx.unitSp, title: "Processo de renderização (fictício)" });
  ids.h = (
    await createHearing(fx.ctx.admin, {
      processId: ids.p,
      kind: "instruction",
      mode: "hybrid",
      date: addDaysISO(today, 2),
      time: "13:45",
      location: "Fórum fictício, sala 1",
      meetingUrl: "https://exemplo.invalid/sala",
      responsibleId: fx.ctx.lawyer.userId,
    })
  ).id;
  ids.past = (
    await createHearing(fx.ctx.admin, {
      processId: ids.p,
      kind: "initial",
      mode: "in_person",
      date: addDaysISO(today, -2),
      time: "09:00",
      location: "Fórum fictício",
    })
  ).id;
  await upsertAlert({
    organizationId: fx.orgA,
    type: "hearing_upcoming",
    severity: "critical",
    title: "Audiência em 2 dias (fictícia)",
    message: "Mensagem fictícia.",
    entityType: "hearing",
    entityId: ids.h,
    dedupeKey: `hearing_upcoming:${ids.h}`,
  });
}, 180_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("server rendering", () => {
  it("renders the process hearings tab with actions for writers and without for readers", async () => {
    const writer = renderToStaticMarkup((await ProcessHearingsTab({ ctx: fx.ctx.lawyer, processId: ids.p })) as ReactElement);
    expect(writer).toContain("Próximas audiências");
    expect(writer).toContain("não integrado nesta versão");
    expect(writer).toContain("Redesignar");
    expect(writer).toContain("Resultado pendente");
    expect(writer).toContain("13:45");

    const reader = renderToStaticMarkup((await ProcessHearingsTab({ ctx: fx.ctx.executive, processId: ids.p })) as ReactElement);
    expect(reader).toContain("Próximas audiências");
    expect(reader).not.toContain("Redesignar");

    const outsider = renderToStaticMarkup((await ProcessHearingsTab({ ctx: fx.ctx.lawyerRe, processId: ids.p })) as ReactElement);
    expect(outsider).toContain("sem permissão");
  });

  it("renders agenda rows with the process link", async () => {
    const { items } = await listHearings(fx.ctx.admin, {});
    const html = renderToStaticMarkup(HearingRow({ item: items[0], users: [], today, showProcess: true }));
    expect(html).toContain(`/processos/${ids.p}?aba=audiencias`);
    expect(html).toContain("Abrir sala virtual");
  });

  it("renders alert rows with links and the resolve button", async () => {
    const items = await listAlerts(fx.ctx.lawyer, {});
    const html = renderToStaticMarkup(AlertRows({ items, canResolve: true, label: "Alertas", showOpenLink: true }));
    expect(html).toContain(`/processos/${ids.p}?aba=audiencias`);
    expect(html).toContain("Resolver");
    expect(html).toContain("Crítico");
  });

  it("renders hearings on the calendar with their own label", async () => {
    const data = await listCalendarItems(fx.ctx.lawyer, addDaysISO(today, 2).slice(0, 7));
    const html = renderToStaticMarkup(WorkCalendar({ data, prevHref: "/prazos", nextHref: "/prazos", todayHref: "/prazos" }));
    expect(html).toContain("Audiência 13:45");
    expect(html).toContain("Audiência às 13:45");
  });
});
