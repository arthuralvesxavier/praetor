"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { int, str } from "@/lib/form";
import { requireActionContext } from "@/server/auth/session";
import { AppError, toActionError, type ActionResult } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { PROBABILITY_BANDS, type ProbabilityBand } from "@/domain/enums";
import { approveLegalReport, generateEngineSample, generateProcessReport, regenerateLegalReport } from "./service";
import { addProcessScenario } from "./scenarios";
import { updateLegalReportSettings } from "./settings-service";

/** Server actions dos relatórios jurídicos: invólucros finos sobre ./service.ts. */

function fail(action: string, err: unknown): { ok: false; error: string; fieldErrors?: Record<string, string[]> } {
  if (!(err instanceof AppError)) {
    logger.error("action_failed", { action, errorName: err instanceof Error ? err.name : typeof err });
  }
  return toActionError(err);
}

const BASE = "/relatorios-juridicos";

export async function generateEngineSampleAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  let id: string;
  try {
    const ctx = await requireActionContext("report:generate");
    const processId = str(formData, "processId");
    const processNumber = str(formData, "processNumber");
    const result = await generateEngineSample(ctx, {
      processId: processId || undefined,
      processNumber: processId ? undefined : processNumber || undefined,
    });
    id = result.id;
    revalidatePath(BASE);
  } catch (err) {
    return fail("generateEngineSample", err);
  }
  redirect(`${BASE}/${id}?gerado=1`);
}

/** "Gerar R1" (lista de relatórios ou ficha do processo): novo R1 ou a versão seguinte do vigente. */
export async function generateProcessReportAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  let id: string;
  try {
    const ctx = await requireActionContext("report:generate");
    const processId = str(formData, "processId");
    const processNumber = str(formData, "processNumber");
    const result = await generateProcessReport(ctx, {
      processId: processId || undefined,
      processNumber: processId ? undefined : processNumber || undefined,
    });
    id = result.id;
    revalidatePath(BASE);
    if (processId) revalidatePath(`/processos/${processId}`);
  } catch (err) {
    return fail("generateProcessReport", err);
  }
  redirect(`${BASE}/${id}?gerado=1`);
}

export async function approveLegalReportAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("legal_report:read");
    const id = str(formData, "id") ?? "";
    await approveLegalReport(ctx, id);
    revalidatePath(BASE);
    revalidatePath(`${BASE}/${id}`);
    return { ok: true, message: "Relatório aprovado. O PDF final foi gerado com o carimbo de aprovação." };
  } catch (err) {
    return fail("approveLegalReport", err);
  }
}

export async function regenerateLegalReportAction(
  _prev: ActionResult<{ id: string }> | null,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  let id: string;
  try {
    const ctx = await requireActionContext("report:generate");
    const result = await regenerateLegalReport(ctx, str(formData, "id") ?? "");
    id = result.id;
    revalidatePath(BASE);
  } catch (err) {
    return fail("regenerateLegalReport", err);
  }
  redirect(`${BASE}/${id}?gerado=1`);
}

export async function updateLegalReportSettingsAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("admin:organization");
    const num = (key: string) => int(formData, key) ?? Number.NaN;
    const bands = Object.fromEntries(
      PROBABILITY_BANDS.map((b) => [b, { min: num(`band_${b}_min`), max: num(`band_${b}_max`) }]),
    ) as Record<(typeof PROBABILITY_BANDS)[number], { min: number; max: number }>;
    const result = await updateLegalReportSettings(ctx, {
      confidenceThreshold: num("confidenceThreshold"),
      bands,
      legalBasisText: str(formData, "legalBasisText") ?? "",
    });
    revalidatePath(`${BASE}/parametros`);
    return { ok: true, message: result.changed ? "Parâmetros salvos." : "Nenhuma alteração." };
  } catch (err) {
    return fail("updateLegalReportSettings", err);
  }
}

export async function addProcessScenarioAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  try {
    const ctx = await requireActionContext("contingency:write");
    const processId = str(formData, "processId") ?? "";
    await addProcessScenario(ctx, processId, {
      description: str(formData, "description") ?? "",
      probabilityBand: (str(formData, "probabilityBand") ?? "") as ProbabilityBand,
      percentMin: int(formData, "percentMin"),
      percentMax: int(formData, "percentMax"),
      comment: str(formData, "comment") ?? null,
    });
    revalidatePath(`/processos/${processId}`);
    return { ok: true, message: "Cenário registrado." };
  } catch (err) {
    return fail("addProcessScenario", err);
  }
}
