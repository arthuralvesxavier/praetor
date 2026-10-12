/**
 * Regression (review: "Auditor role reads the full audit trail, including
 * diffs of confidential processes it cannot otherwise see").
 *
 * Readers of the audit trail who do not see confidential records (the
 * auditor) keep every entry — the trail stays complete — but entries about
 * confidential records (and their children, linked work items and documents,
 * documents that are not `internal` or hold health data) come without summary
 * and field diff. Same rule in the list, the CSV export and the overview.
 * Admins and legal managers are unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAuditCsv } from "@/modules/admin/audit-csv";
import {
  AUDIT_REDACTED_SUMMARY,
  exportAuditLogs,
  getAdminOverview,
  listAuditLogs,
  type AuditLogItem,
} from "@/modules/admin/service";
import { createHearing } from "@/modules/hearings/service";
import { deleteProcess, getProcess } from "@/modules/processes/service";
import { NotFoundError } from "@/server/lib/errors";
import { addDaysISO, todayISO } from "@/lib/format";
import {
  makeContract,
  makeDeadline,
  makeOccurrence,
  makeProcess,
  makeTextDocument,
  runJobs,
  setupFixture,
  type Fixture,
} from "../../helpers/fixtures";

const SECRET = "QWE";
const PUBLIC = "ASDPUB";

let f: Fixture;
const ids: Record<string, string> = {};

function text(items: AuditLogItem[]): string {
  return JSON.stringify(items.map((i) => ({ summary: i.summary, changes: i.changes, refNames: i.refNames })));
}

beforeAll(async () => {
  f = await setupFixture("fix-audit-conf");
  const { admin, manager } = f.ctx;

  ids.confProcess = await makeProcess(manager, {
    title: `Processo SIGILOSO ${SECRET}`,
    isConfidential: true,
    claimAmountCents: 987_654_00,
  });
  ids.confOccurrence = await makeOccurrence(manager, { title: `Ocorrência SIGILOSA ${SECRET}`, isConfidential: true });
  ids.confContract = await makeContract(manager, { title: `Contrato SIGILOSO ${SECRET}`, isConfidential: true });
  ids.publicProcess = await makeProcess(manager, { title: `Processo público ${PUBLIC}` });

  // Children and linked items of the confidential process.
  await createHearing(admin, {
    processId: ids.confProcess,
    kind: "initial",
    mode: "in_person",
    date: addDaysISO(todayISO(), 5),
    time: "09:00",
    location: `Fórum ${SECRET}`,
  });
  ids.confDeadline = await makeDeadline(manager, { processId: ids.confProcess, title: `Prazo ${SECRET}` });
  ids.confDoc = (
    await makeTextDocument(admin, {
      processId: ids.confProcess,
      title: `Petição ${SECRET}`,
      text: "Petição do processo sigiloso (texto fictício).",
    })
  ).documentId;

  // Documents of a public process hidden from the auditor by level/category.
  await makeTextDocument(admin, {
    processId: ids.publicProcess,
    title: `Parecer restrito ${SECRET}`,
    confidentiality: "restricted",
    text: "Parecer restrito (texto fictício).",
  });
  await makeTextDocument(admin, {
    processId: ids.publicProcess,
    title: `Atestado ${SECRET}`,
    category: "sensitive_health",
    text: "Atestado médico fictício.",
  });
  await makeTextDocument(admin, {
    processId: ids.publicProcess,
    title: `Petição pública ${PUBLIC}`,
    text: "Petição do processo público (texto fictício).",
  });

  // A deleted confidential process: its deletion entry stays redacted too.
  ids.deletedConf = await makeProcess(manager, { title: `Processo SIGILOSO excluído ${SECRET}`, isConfidential: true });
  await deleteProcess(admin, ids.deletedConf);

  await runJobs();
}, 180_000);

afterAll(async () => {
  await f?.teardown();
});

describe("audit trail confidentiality (auditor)", () => {
  it("the auditor cannot read the confidential process itself (precondition)", async () => {
    await expect(getProcess(f.ctx.auditor, ids.confProcess)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("entries about the confidential process are kept but redacted for the auditor", async () => {
    const { auditor } = f.ctx;
    const { items, total } = await listAuditLogs(auditor, { entityType: "legal_process", entityId: ids.confProcess });
    expect(total).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.redacted).toBe(true);
      expect(item.summary).toBe(AUDIT_REDACTED_SUMMARY);
      expect(item.changes).toBeNull();
    }
    expect(text(items)).not.toContain(SECRET);
  });

  it("the whole trail never shows confidential content to the auditor, but keeps public entries and every row", async () => {
    const { auditor, admin } = f.ctx;
    const asAuditor = await listAuditLogs(auditor, { pageSize: 100 });
    const asAdmin = await listAuditLogs(admin, { pageSize: 100 });
    // Same rows (the trail is complete), different content.
    expect(asAuditor.total).toBe(asAdmin.total);
    expect(text(asAuditor.items)).not.toContain(SECRET);
    expect(text(asAuditor.items)).toContain(PUBLIC);
    expect(text(asAdmin.items)).toContain(SECRET);

    const redactedTypes = new Set(asAuditor.items.filter((i) => i.redacted).map((i) => i.entityType));
    for (const type of ["legal_process", "occurrence", "contract", "deadline", "document"]) {
      expect(redactedTypes.has(type as AuditLogItem["entityType"])).toBe(true);
    }
    // The deletion of a confidential process is redacted too.
    const deletion = asAuditor.items.filter((i) => i.entityId === ids.deletedConf);
    expect(deletion.length).toBeGreaterThan(0);
    expect(deletion.every((i) => i.redacted)).toBe(true);
    // The public document stays readable.
    expect(asAuditor.items.some((i) => !i.redacted && i.summary.includes(`Petição pública ${PUBLIC}`))).toBe(true);
  });

  it("the CSV export and the admin overview apply the same redaction", async () => {
    const { auditor, manager } = f.ctx;
    const exported = await exportAuditLogs(auditor);
    expect(text(exported.items)).not.toContain(SECRET);
    const csv = buildAuditCsv(exported.items);
    expect(csv).not.toContain(SECRET);
    expect(csv).toContain(PUBLIC);

    const overview = await getAdminOverview(auditor);
    expect(text(overview.recentAudit ?? [])).not.toContain(SECRET);

    // Legal managers see confidential records: nothing is redacted for them.
    const asManager = await exportAuditLogs(manager);
    expect(asManager.items.every((i) => !i.redacted)).toBe(true);
    expect(buildAuditCsv(asManager.items)).toContain(SECRET);
  });
});
