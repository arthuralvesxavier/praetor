/**
 * Helpers of the briefs suite: labor processes coherent with the demo
 * document pack, created through the real services.
 */
import { eq } from "drizzle-orm";
import { computeCnjCheckDigit } from "@/domain/cnj";
import { buildDemoCaseDocuments, type DemoCaseInfo } from "@/modules/briefs/demo-documents";
import { uploadDocument } from "@/modules/documents/service";
import { addParty, createProcess } from "@/modules/processes/service";
import type { AuthContext } from "@/server/auth/context";
import { getDb } from "@/server/db/client";
import { caseIntakes, legalProcesses } from "@/server/db/schema";

let seq = 100;

/** Valid CNJ (check digit computed) for the labor segment, TRT10. */
export function validCnj(n = seq++): string {
  const parts = { sequence: String(n).padStart(7, "0"), year: 2026, segment: "5", tribunal: "10", origin: "0801" };
  const dd = computeCnjCheckDigit(parts);
  return `${parts.sequence}-${dd}.${parts.year}.${parts.segment}.${parts.tribunal}.${parts.origin}`;
}

export function demoInfo(overrides: Partial<DemoCaseInfo> = {}): DemoCaseInfo {
  return {
    number: validCnj(),
    court: "TRT10",
    courtDivision: "1ª Vara do Trabalho de Palmas",
    city: "Palmas",
    state: "TO",
    plaintiff: "JOÃO DA SILVA TESTE (FICTÍCIO)",
    defendant: "EMPRESA MODELO TESTE LTDA",
    processClass: "ATOrd",
    claimAmountCents: 8_543_210,
    filedAt: "2026-09-20",
    ...overrides,
  };
}

export async function makeLaborProcess(
  ctx: AuthContext,
  info: DemoCaseInfo,
  extra: { unitId?: string | null; responsibleId?: string | null; isConfidential?: boolean; lawFirmId?: string | null } = {},
): Promise<string> {
  const { id } = await createProcess(ctx, {
    number: info.number,
    title: `${info.plaintiff} x ${info.defendant}`,
    court: info.court,
    courtDivision: info.courtDivision,
    area: "labor",
    phase: "knowledge",
    filedAt: info.filedAt,
    claimAmountCents: info.claimAmountCents,
    unitId: extra.unitId ?? null,
    responsibleId: extra.responsibleId ?? null,
    isConfidential: extra.isConfidential ?? false,
    city: info.city,
    state: info.state,
    processClass: info.processClass,
  });
  await addParty(ctx, id, { name: info.plaintiff, role: "plaintiff" });
  await addParty(ctx, id, { name: info.defendant, role: "defendant", isClient: true });
  if (extra.lawFirmId) {
    // Set directly so the suite does not depend on the portfolio form persisting v2 fields.
    await getDb().update(legalProcesses).set({ lawFirmId: extra.lawFirmId }).where(eq(legalProcesses.id, id));
  }
  return id;
}

export async function uploadDemoPack(
  ctx: AuthContext,
  processId: string,
  info: DemoCaseInfo,
  opts: { variant?: number; confidentiality?: "internal" | "confidential" | "restricted"; only?: number[] } = {},
): Promise<{ documentId: string; versionId: string; title: string }[]> {
  const docs = await buildDemoCaseDocuments(info, { variant: opts.variant });
  const out: { documentId: string; versionId: string; title: string }[] = [];
  for (const [i, d] of docs.entries()) {
    if (opts.only && !opts.only.includes(i)) continue;
    const r = await uploadDocument(ctx, {
      title: d.title,
      category: d.category,
      description: d.description,
      confidentiality: opts.confidentiality ?? "internal",
      processId,
      file: { name: d.fileName, bytes: d.bytes },
    });
    out.push({ ...r, title: d.title });
  }
  return out;
}

/**
 * Intake row of a process, inserted directly (the intake pipeline is not under
 * test here): `requestCaseBrief` accepts analysts only with an intake of the process.
 */
export async function insertIntake(
  organizationId: string,
  processId: string,
  values: Partial<typeof caseIntakes.$inferInsert> = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(caseIntakes)
    .values({ organizationId, processId, source: "manual", status: "assigned", ...values })
    .returning({ id: caseIntakes.id });
  return row.id;
}
