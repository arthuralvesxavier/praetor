import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "@/domain/demo";
import { todayISO } from "@/lib/format";
import { isValidIsoDate } from "@/modules/contingency/rules";
import { isHttpUrl } from "@/modules/hearings/time";
import { AURORA_UNITS, AURORA_USERS } from "../../scripts/seed-data/aurora";
import {
  AURORA_V2_USERS,
  DEMO_SPREADSHEET,
  GUARANTEE_DESCRIPTIONS,
  RISK_OPINIONS,
  RISK_RECLASSIFICATION_OPINION,
  RULE_APPROVAL_NOTE,
  V2_COMPANY_NAME,
  V2_HEARINGS,
  V2_LAW_FIRM,
  V2_PAST_HEARING,
  V2_RULES,
  V2_SETTLEMENT_NOTES,
  V2_UNITS,
  hearingLocation,
  hearingUrl,
} from "../../scripts/seed-data/v2/aurora-v2";

const V1_KEYS = new Set(Object.values(AURORA_USERS).map((u) => u.key));
const V2_KEYS = new Set(Object.values(AURORA_V2_USERS).map((u) => u.key));

describe("v2 demo seed data", () => {
  it("creates the v2 accounts with the expected roles and scopes", () => {
    const role = (email: string) => DEMO_ACCOUNTS.find((a) => a.email === email)?.role;
    expect(role("contabilidade@demo.praetor.local")).toBe("accountant");
    expect(role("auditoria@demo.praetor.local")).toBe("auditor");
    expect(role("escritorio@demo.praetor.local")).toBe("external_counsel");
    for (const [email, meta] of Object.entries(AURORA_V2_USERS)) {
      const r = role(email);
      expect(r).toBeDefined();
      // External counsel belongs to the law firm and has no unit; lawyers belong to a regional unit.
      expect(meta.lawFirm).toBe(r === "external_counsel");
      if (r === "external_counsel" || r === "accountant" || r === "auditor") expect(meta.unit).toBeNull();
      if (r === "lawyer") expect(meta.unit).not.toBeNull();
    }
  });

  it("labels the law firm, units, opinions and notes as fictitious", () => {
    expect(V2_LAW_FIRM.name).toContain("(fictício)");
    expect(V2_LAW_FIRM.contactEmail.endsWith(".invalid")).toBe(true);
    for (const u of V2_UNITS) expect(u.name).toContain("(fictícia)");
    for (const list of Object.values(RISK_OPINIONS)) {
      expect(list.length).toBeGreaterThan(0);
      for (const o of list) {
        expect(o).toContain("fictício");
        expect(o.length).toBeGreaterThanOrEqual(10);
        expect(o.length).toBeLessThanOrEqual(2000);
      }
    }
    for (const text of [RISK_RECLASSIFICATION_OPINION, RULE_APPROVAL_NOTE, V2_PAST_HEARING.outcome, hearingLocation("Palmas", "1ª Vara")]) {
      expect(text).toMatch(/fictíci/);
    }
    for (const text of [...Object.values(V2_SETTLEMENT_NOTES), ...Object.values(GUARANTEE_DESCRIPTIONS)]) {
      expect(text).toContain("(dados fictícios)");
    }
  });

  it("uses the client's FICTITIOUS spreadsheet and the exact client party name", () => {
    expect(DEMO_SPREADSHEET.fileName).toMatch(/DADOS_FICTICIOS\.xlsx$/);
    expect(existsSync(path.resolve(process.cwd(), "scripts", "seed-data", "files", DEMO_SPREADSHEET.fileName))).toBe(true);
    expect(isValidIsoDate(DEMO_SPREADSHEET.baseDate)).toBe(true);
    expect(DEMO_SPREADSHEET.baseDate <= todayISO()).toBe(true);
    expect(V2_COMPANY_NAME).toBe("EMPRESA MODELO TESTE LTDA");
  });

  it("builds distribution rules from known users, units and unique priorities", () => {
    const priorities = V2_RULES.map((r) => r.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
    const unitKeys = new Set<string>([...V2_UNITS.map((u) => u.key), ...AURORA_UNITS.map((u) => u.key)]);
    for (const r of V2_RULES) {
      expect(r.users.length).toBeGreaterThan(0);
      for (const k of r.users) expect(V1_KEYS.has(k as never) || V2_KEYS.has(k as never)).toBe(true);
      if (r.unit) expect(unitKeys.has(r.unit)).toBe(true);
      expect((r.courts?.length ?? 0) + (r.instances?.length ?? 0)).toBeGreaterThan(0);
    }
    // Only the external counsel's rule sets the law firm.
    for (const r of V2_RULES) expect(Boolean(r.lawFirm)).toBe(r.users.includes("escritorio"));
  });

  it("schedules hearings within the next 20 days, with fictitious meeting links", () => {
    for (const h of V2_HEARINGS) {
      expect(h.days).toBeGreaterThanOrEqual(1);
      expect(h.days).toBeLessThanOrEqual(20);
      expect(h.time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
    expect(V2_PAST_HEARING.days).toBeLessThan(0);
    const url = hearingUrl(1);
    expect(isHttpUrl(url)).toBe(true);
    expect(new URL(url).hostname.endsWith(".invalid")).toBe(true);
  });
});
