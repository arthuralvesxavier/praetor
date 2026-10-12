/**
 * Cenário do R1 (Relatório de Processo) para os testes: processo trabalhista
 * fictício com o pacote de documentos de demonstração (texto paginado), atestado
 * médico (documento sensível), análise preliminar simulada, pedidos com avaliação,
 * valores oficiais com índice, garantias, movimentações no formato do DataJud,
 * instâncias de origem e recursal, prazo, audiência e valores propostos lidos de
 * documento. Tudo pelos serviços reais, exceto o que não tem serviço próprio
 * (movimentações coletadas do DataJud, instâncias importadas, taxas de índice).
 */
import { and, eq } from "drizzle-orm";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseMoneyToCents, todayISO } from "@/lib/format";
import { approveCaseBrief, requestCaseBrief } from "@/modules/briefs/service";
import { assessClaim, createClaim } from "@/modules/claims/service";
import { createGuarantee, setGuaranteeStatus } from "@/modules/contingency/guarantee-service";
import { addValuation, proposeValuation } from "@/modules/contingency/service";
import { DATAJUD_SOURCE_LABEL } from "@/modules/court-sync/mapping";
import { getDocumentVersionPageText, uploadDocument } from "@/modules/documents/service";
import { createHearing } from "@/modules/hearings/service";
import { ensureIndexCatalog, setValuationCorrectionIndex } from "@/modules/indices/service";
import { flagProcessForVerification } from "@/modules/processes/service";
import type { AuthContext } from "@/server/auth/context";
import {
  caseBriefSources,
  caseBriefs,
  documents,
  indexSeriesValues,
  legalProcesses,
  processEvents,
  processInstances,
  processValuations,
} from "@/server/db/schema";
import { demoInfo, makeLaborProcess, uploadDemoPack } from "../../briefs/helpers";
import { daysFromToday, makeDeadline, runJobs, type Fixture } from "../../helpers/fixtures";

export type R1World = {
  processId: string;
  number: string;
  briefId: string;
  sensitiveDocumentId: string;
  sensitiveExcerpt: string;
  claimIds: string[];
};

export async function textPdf(pages: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = pdf.addPage([595, 842]);
    text.split("\n").forEach((line, i) => page.drawText(line, { x: 50, y: 780 - i * 16, size: 11, font }));
  }
  return pdf.save();
}

/** Taxas mensais FICTÍCIAS de índice (dados de teste, não são as publicadas pelo Banco Central). */
async function seedIndexRates(fx: Fixture): Promise<void> {
  await ensureIndexCatalog(fx.db);
  const ipcaE = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"].map((month, i) => ({
    indexCode: "ipca_e" as const,
    month,
    ratePercent: ["0.310000", "0.260000", "0.240000", "0.190000", "0.210000", "0.330000"][i],
    source: "teste:ficticio",
  }));
  // INPC com um mês faltando (06/2026): a atualização fica indisponível, nunca estimada.
  const inpc = ["2026-04", "2026-05", "2026-07"].map((month, i) => ({
    indexCode: "inpc" as const,
    month,
    ratePercent: ["0.280000", "0.300000", "0.150000"][i],
    source: "teste:ficticio",
  }));
  await fx.db.insert(indexSeriesValues).values([...ipcaE, ...inpc]).onConflictDoNothing();
}

/**
 * Monta o processo completo. `approveBrief`: aprova a análise preliminar no fim
 * (enfileira a geração automática do R1; os testes chamam `runJobs`).
 */
export async function buildR1World(fx: Fixture, opts: { approveBrief?: boolean; lawFirmId?: string | null } = {}): Promise<R1World> {
  const manager = fx.ctx.manager;
  const lawyer = fx.ctx.lawyer;
  await seedIndexRates(fx);
  const info = demoInfo({ filedAt: "2026-03-10" });
  const processId = await makeLaborProcess(manager, info, {
    unitId: fx.unitSp,
    responsibleId: lawyer.userId,
    lawFirmId: opts.lawFirmId ?? null,
  });
  await fx.db.update(legalProcesses).set({ companyId: fx.companyA, instance: "second" }).where(eq(legalProcesses.id, processId));
  await fx.db.insert(processInstances).values([
    {
      organizationId: fx.orgA,
      processId,
      instance: "first",
      court: "TRT10",
      courtDivision: "1ª Vara do Trabalho de Palmas",
      city: "Palmas",
      state: "TO",
      processClass: "ATOrd",
      phase: "knowledge",
      isCurrent: false,
      origin: "imported",
    },
    {
      organizationId: fx.orgA,
      processId,
      instance: "second",
      court: "TRT10",
      courtDivision: "1ª Turma",
      processClass: "ROT",
      phase: "knowledge",
      isCurrent: true,
      origin: "imported",
    },
  ]);

  await uploadDemoPack(manager, processId, info, { variant: 0 });
  const sensitiveText = "Atestado medico ficticio emitido para o teste do relatorio do processo.\nAfastamento por quinze dias por motivo de saude (dado sensivel de teste).";
  const sensitive = await uploadDocument(manager, {
    title: "Atestado médico (fictício)",
    category: "sensitive_health",
    processId,
    file: { name: "atestado.pdf", bytes: await textPdf([sensitiveText]) },
  });
  await runJobs();

  // Movimentações: coletadas do DataJud (importadas, por grau) e uma anotação manual.
  const movements: { date: string; title: string; instance: "first" | "second" }[] = [
    { date: "2026-03-10", title: "Distribuído por sorteio", instance: "first" },
    { date: "2026-03-12", title: "Juntada de petição", instance: "first" },
    { date: "2026-05-20", title: "Audiência de conciliação realizada sem acordo", instance: "first" },
    { date: "2026-07-02", title: "Sentença publicada", instance: "first" },
    { date: "2026-08-14", title: "Recurso ordinário interposto pela reclamada", instance: "first" },
    { date: "2026-09-01", title: "Remessa em grau de recurso", instance: "first" },
    { date: "2026-09-05", title: "Recebidos os autos no tribunal", instance: "second" },
    { date: "2026-09-18", title: "Conclusos ao relator", instance: "second" },
  ];
  await fx.db.insert(processEvents).values([
    ...movements.map((m, i) => ({
      organizationId: fx.orgA,
      processId,
      occurredAt: m.date,
      type: "other" as const,
      title: m.title,
      origin: "imported" as const,
      externalSource: DATAJUD_SOURCE_LABEL,
      instance: m.instance,
      externalId: `teste|${m.date}|${i}`,
    })),
    {
      organizationId: fx.orgA,
      processId,
      occurredAt: "2026-08-20",
      type: "note" as const,
      title: "Reunião interna para definir a estratégia recursal",
      origin: "manual" as const,
      instance: "first" as const,
    },
  ]);

  // Análise preliminar simulada (lê todos os documentos com texto, inclusive o atestado).
  const { briefId } = await requestCaseBrief(lawyer, processId, { inline: true });
  await runJobs();
  // O atestado entra na linha do tempo da análise como item extraído (citação literal), para o teste de documento sensível.
  const [sensitiveRef] = await fx.db
    .select({ ref: caseBriefSources.ref })
    .from(caseBriefSources)
    .where(and(eq(caseBriefSources.briefId, briefId), eq(caseBriefSources.entityId, sensitive.documentId)));
  const sensitivePage = await getDocumentVersionPageText(manager, sensitive.documentId, sensitive.versionId, 1);
  const sensitiveExcerpt = sensitivePage.text.split(/\n+/).map((l) => l.trim()).find((l) => l.startsWith("Afastamento")) ?? "";
  if (sensitiveRef && sensitiveExcerpt) {
    const [b] = await fx.db.select({ content: caseBriefs.content }).from(caseBriefs).where(eq(caseBriefs.id, briefId));
    const content = b.content!;
    content.timeline.push({
      date: "2026-02-02",
      description: "Afastamento médico do reclamante por quinze dias (segundo o atestado)",
      provenance: "extracted",
      citations: [{ ref: sensitiveRef.ref, page: 1, excerpt: sensitiveExcerpt }],
      note: null,
    });
    await fx.db.update(caseBriefs).set({ content }).where(eq(caseBriefs.id, briefId));
  }

  // Pedidos confirmados com avaliação (risco por pedido).
  const today = todayISO();
  const a = await createClaim(lawyer, processId, {
    description: "Horas extras e reflexos (fictício)",
    category: "overtime",
    claimedAmountCents: 4_500_000,
    amountBaseDate: "2026-03-31",
    correctionIndex: "ipca_e",
  });
  const b = await createClaim(lawyer, processId, {
    description: "Adicional de insalubridade (fictício)",
    category: "health_hazard_pay",
    claimedAmountCents: 1_250_000,
    amountBaseDate: "2026-03-31",
    correctionIndex: "inpc",
  });
  const c = await createClaim(lawyer, processId, {
    description: "Indenização por dano moral (fictício, sem valor informado)",
    category: "moral_damages",
  });
  await assessClaim(lawyer, a.id, {
    classification: "possible",
    percentage: 50,
    opinion: "Parecer fictício: prova documental parcial das horas extras alegadas.",
    effectiveFrom: today,
  });
  await assessClaim(lawyer, b.id, {
    classification: "probable",
    percentage: 75,
    opinion: "Parecer fictício: laudo pericial desfavorável à empresa no processo de teste.",
    effectiveFrom: today,
  });
  await assessClaim(lawyer, c.id, {
    classification: "remote",
    opinion: "Parecer fictício: não há prova de ofensa à honra no processo de teste.",
    effectiveFrom: today,
  });

  // Valores: apurado oficial (índice IPCA-E por novo registro) e propostos lidos da planilha de cálculos.
  const liquidated = await addValuation(manager, {
    processId,
    kind: "liquidated",
    amountCents: 3_456_789,
    baseDate: "2026-06-30",
    source: "manual",
    reason: "Cálculo de liquidação (fictício)",
  });
  await setValuationCorrectionIndex(manager, liquidated.id, "ipca_e");
  const docs = await fx.db
    .select({ id: documents.id, title: documents.title, versionId: documents.currentVersionId })
    .from(documents)
    .where(eq(documents.processId, processId));
  const calc = docs.find((d) => /c[aá]lculo/i.test(d.title)) ?? docs[0];
  const page = await getDocumentVersionPageText(manager, calc.id, calc.versionId as string, 1);
  const money = page.text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => /R\$\s?[\d.]+,\d{2}/.test(l) && l.length >= 20 && l.length <= 200 && !/[\u2012-\u2015]/.test(l));
  for (const [i, line] of money.slice(0, 2).entries()) {
    await proposeValuation(manager, {
      processId,
      kind: "estimate",
      amountCents: parseMoneyToCents(/R\$\s?([\d.]+,\d{2})/.exec(line)?.[1] ?? "") ?? 0,
      baseDate: "2026-09-20",
      source: "document",
      documentId: calc.id,
      documentVersionId: calc.versionId,
      page: 1,
      excerpt: line,
      confidence: i === 0 ? 92 : 55,
      reason: "Leitura da planilha de cálculos (fictício)",
    });
  }

  // Garantias: depósito recursal vinculado e depósito judicial já levantado (não abate).
  await createGuarantee(manager, processId, {
    kind: "appeal_deposit",
    amountCents: 1_200_000,
    depositedAt: "2026-08-14",
    description: "Depósito recursal (fictício)",
  });
  const released = await createGuarantee(manager, processId, {
    kind: "judicial_deposit",
    amountCents: 300_000,
    depositedAt: "2026-05-02",
    description: "Depósito judicial (fictício)",
  });
  await setGuaranteeStatus(manager, released.id, { status: "released_to_plaintiff", statusChangedAt: "2026-07-20" });

  await makeDeadline(lawyer, {
    processId,
    title: "Contrarrazões ao recurso da parte contrária (fictício)",
    dueDate: daysFromToday(8),
    kind: "procedural",
  });
  await createHearing(lawyer, { processId, kind: "judgment_session", mode: "virtual", date: daysFromToday(21), time: "14:00" });
  await flagProcessForVerification(manager, processId, { note: "Conferir a classe processual da instância recursal (fictício)." });

  if (opts.approveBrief) await approveCaseBrief(lawyer, briefId, { note: "Conferido (teste do R1)." });
  return {
    processId,
    number: info.number,
    briefId,
    sensitiveDocumentId: sensitive.documentId,
    sensitiveExcerpt,
    claimIds: [a.id, b.id, c.id],
  };
}

/** Valoração oficial vigente de um tipo (para os testes de soma). */
export async function officialValue(fx: Fixture, processId: string, kind: "claim" | "liquidated"): Promise<number> {
  const rows = await fx.db
    .select({ amount: processValuations.amountCents, status: processValuations.status })
    .from(processValuations)
    .where(and(eq(processValuations.processId, processId), eq(processValuations.kind, kind), eq(processValuations.status, "official")));
  return rows[0].amount;
}

export type { AuthContext };
