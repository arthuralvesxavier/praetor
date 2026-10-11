/**
 * Data each e-mail template needs (cross-module contract: callers build the
 * data, the emails module renders subject/text/html). Client-safe types.
 * The emails package adds the renderers in this module.
 */
import type { EmailTemplate } from "@/domain/enums";

export type CaseBriefReadyData = {
  processNumber: string;
  processTitle: string;
  court: string | null;
  /** "Autor x Empresa". */
  parties: string;
  headline: string;
  urgencies: string[];
  possibleDeadlines: { description: string; date: string | null }[];
  gapsCount: number;
  missingDocumentsCount: number;
  /** Demo-mode brief: the e-mail must say so. */
  isDemo: boolean;
  briefVersion: number;
};

export type IntakeAssignedData = {
  processNumber: string;
  processTitle: string;
  court: string | null;
  /** pt-BR explanation of the assignment (rule, load, manual). */
  assignmentReason: string;
  /** ISO timestamp. */
  receivedAt: string;
};

export type DeadlineReminderData = {
  title: string;
  dueDate: string;
  processNumber: string | null;
  pendingValidation: boolean;
};

export type HearingReminderData = {
  processNumber: string;
  processTitle: string;
  kindLabel: string;
  modeLabel: string;
  /** ISO timestamp. */
  scheduledAt: string;
  location: string | null;
};

export type DailyDigestData = {
  items: { label: string; count: number; path: string }[];
};

export type BriefApprovedData = {
  processNumber: string;
  processTitle: string;
  approvedByName: string;
  briefVersion: number;
};

export type EmailTemplateDataMap = {
  case_brief_ready: CaseBriefReadyData;
  intake_assigned: IntakeAssignedData;
  deadline_reminder: DeadlineReminderData;
  hearing_reminder: HearingReminderData;
  daily_digest: DailyDigestData;
  brief_approved: BriefApprovedData;
};

export type EmailTemplateData<T extends EmailTemplate> = EmailTemplateDataMap[T];
