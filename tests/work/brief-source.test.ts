import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDaysISO, todayISO } from "@/lib/format";
import {
  createSuggestedDeadline,
  createTask,
  getDeadline,
  getTask,
  listDeadlines,
  validateDeadline,
} from "@/modules/work/service";
import { caseBriefs } from "@/server/db/schema";
import { ValidationError } from "@/server/lib/errors";
import { makeProcess, setupFixture, type Fixture } from "../helpers/fixtures";

/**
 * Deadlines and tasks suggested by the preliminary case analysis (simulated in
 * this version) use the existing createSuggestedDeadline / createTask with the
 * brief id as `sourceAnalysisId`. They stay pending validation and are labeled
 * by their source kind.
 */

let fx: Fixture;
const ids: Record<string, string> = {};

beforeAll(async () => {
  fx = await setupFixture("wbrief");
  ids.pSp = await makeProcess(fx.ctx.admin, { unitId: fx.unitSp, title: "Processo SP (fictício)" });
  const [brief] = await fx.db
    .insert(caseBriefs)
    .values({
      organizationId: fx.orgA,
      processId: ids.pSp,
      version: 1,
      status: "ready_for_review",
      mode: "demo",
      provider: "simulado",
      model: "simulado",
      promptVersion: "teste",
      inputHash: "teste",
    })
    .returning();
  ids.brief = brief.id;
}, 180_000);

afterAll(async () => {
  await fx?.teardown();
});

describe("suggestions from the preliminary case analysis", () => {
  it("creates a pending AI-suggested deadline labeled by its source kind", async () => {
    const { id } = await createSuggestedDeadline(fx.ctx.lawyer, {
      title: "Possível prazo para contestação (conferir)",
      dueDate: addDaysISO(todayISO(), 12),
      kind: "procedural",
      sourceAnalysisId: ids.brief,
      sourceExcerpt: "Trecho fictício: prazo de 15 dias para contestação.",
      processId: ids.pSp,
    });
    const d = await getDeadline(fx.ctx.lawyer, id);
    expect(d.origin).toBe("ai_suggested");
    expect(d.validationStatus).toBe("pending_validation");
    expect(d.isPendingValidation).toBe(true);
    expect(d.countsAsDeadline).toBe(false);
    expect(d.sourceKind).toBe("case_brief");
    expect(d.sourceAnalysisVisible).toBe(true);
    expect(d.sourceExcerpt).toContain("15 dias");

    const pending = await listDeadlines(fx.ctx.lawyer, { validationStatus: "pending_validation" });
    expect(pending.items.find((x) => x.id === id)?.sourceKind).toBe("case_brief");
    const real = await listDeadlines(fx.ctx.lawyer, { situation: "open" });
    expect(real.items.map((x) => x.id)).not.toContain(id);

    await validateDeadline(fx.ctx.lawyer, id, { decision: "validated" });
    const validated = await getDeadline(fx.ctx.lawyer, id);
    expect(validated.countsAsDeadline).toBe(true);
    expect(validated.sourceKind).toBe("case_brief");
  });

  it("rejects a brief the user cannot see (other unit, other organization)", async () => {
    const input = {
      title: "Sugestão",
      dueDate: addDaysISO(todayISO(), 5),
      kind: "procedural" as const,
      sourceAnalysisId: ids.brief,
      sourceExcerpt: "Trecho.",
    };
    await expect(createSuggestedDeadline(fx.ctx.lawyerRe, input)).rejects.toBeInstanceOf(ValidationError);
    await expect(createSuggestedDeadline(fx.ctx.adminB, input)).rejects.toBeInstanceOf(ValidationError);
  });

  it("accepts a brief as the source of an AI-suggested task", async () => {
    const { id } = await createTask(fx.ctx.lawyer, {
      title: "Reunir documentos indicados como faltantes",
      processId: ids.pSp,
      origin: "ai_suggested",
      sourceAnalysisId: ids.brief,
    });
    const t = await getTask(fx.ctx.lawyer, id);
    expect(t.origin).toBe("ai_suggested");
    expect(t.sourceKind).toBe("case_brief");
  });
});
