import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EntityType, Role } from "@/domain/enums";
import { createdAt, id, ts, updatedAt } from "./_columns";

export type OrganizationSettings = {
  ai: {
    /** Max tokens (input + output) per calendar month for live AI calls. 0 = AI disabled. */
    monthlyTokenBudget: number;
    /** Max characters of source text sent in a single analysis request. */
    maxInputChars: number;
    /** Enqueue a summary analysis automatically when a new document version is uploaded. */
    autoAnalyzeOnUpload: boolean;
  };
  alerts: {
    /** A deadline is "upcoming" when due within this many days. */
    upcomingDeadlineDays: number;
    /** A contract is "expiring" when it ends within this many days. */
    contractExpirationDays: number;
  };
  retention: {
    /** Days after closure before closed/archived records become eligible for deletion review. */
    closedRecordRetentionDays: number;
    /** Days audit log entries are kept. */
    auditLogRetentionDays: number;
  };
};

export const DEFAULT_ORGANIZATION_SETTINGS: OrganizationSettings = {
  ai: { monthlyTokenBudget: 2_000_000, maxInputChars: 120_000, autoAnalyzeOnUpload: true },
  alerts: { upcomingDeadlineDays: 7, contractExpirationDays: 60 },
  retention: { closedRecordRetentionDays: 1825, auditLogRetentionDays: 1825 },
};

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** Demo organizations show the "ambiente demonstrativo" banner. */
  isDemo: boolean("is_demo").notNull().default(false),
  settings: jsonb("settings").$type<OrganizationSettings>().notNull().default(DEFAULT_ORGANIZATION_SETTINGS),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const units = pgTable(
  "units",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    code: text("code"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("units_org_name_uq").on(t.organizationId, t.name)],
);

export const users = pgTable(
  "users",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    /** Stored lower-case. Unique across the whole installation (login is by e-mail). */
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").$type<Role>().notNull(),
    /** Primary unit. Lawyers and analysts only see records of their unit (see src/server/auth/access.ts). */
    unitId: uuid("unit_id").references(() => units.id),
    jobTitle: text("job_title"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email), index("users_org_idx").on(t.organizationId)],
);

export const teams = pgTable(
  "teams",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    description: text("description"),
    unitId: uuid("unit_id").references(() => units.id),
    leaderId: uuid("leader_id").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("teams_org_name_uq").on(t.organizationId, t.name)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the random session token. The raw token only exists in the user's cookie. */
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    expiresAt: ts("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Append-only audit trail. `changes` holds field-level diffs with sensitive
 * fields redacted (see src/server/services/audit.ts). Never store document
 * contents or AI prompts here.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    actorId: uuid("actor_id").references(() => users.id),
    /** Dotted action name, e.g. `legal_process.update`, `analysis.request`, `auth.login`. */
    action: text("action").notNull(),
    entityType: text("entity_type").$type<EntityType>().notNull(),
    entityId: uuid("entity_id"),
    summary: text("summary").notNull(),
    changes: jsonb("changes").$type<Record<string, { from: unknown; to: unknown }>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_org_created_idx").on(t.organizationId, t.createdAt),
    index("audit_entity_idx").on(t.entityType, t.entityId),
  ],
);

