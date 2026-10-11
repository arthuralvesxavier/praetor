CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"document" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "law_firms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"document" text,
	"contact_name" text,
	"contact_email" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"instance" text NOT NULL,
	"court" text NOT NULL,
	"court_division" text,
	"city" text,
	"state" text,
	"process_class" text,
	"phase" text,
	"phase_detail" text,
	"claim_amount_cents" bigint,
	"liquidated_amount_cents" bigint,
	"is_current" boolean DEFAULT false NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"import_batch_id" uuid,
	"source_sheet" text,
	"source_row" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshot_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"number" text NOT NULL,
	"company_id" uuid,
	"unit_id" uuid,
	"court" text,
	"instance" text,
	"phase" text,
	"city" text,
	"is_confidential" boolean DEFAULT false NOT NULL,
	"classification" text,
	"percentage_bp" integer,
	"claim_amount_cents" bigint,
	"liquidated_amount_cents" bigint,
	"guarantees_cents" bigint DEFAULT 0 NOT NULL,
	"exposure_cents" bigint,
	"exposure_is_estimate" boolean DEFAULT false NOT NULL,
	"provision_cents" bigint,
	"provision_is_estimate" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period" text NOT NULL,
	"reference_date" date NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"metrics" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by_id" uuid,
	"closed_at" timestamp with time zone,
	"closed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_guarantees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" text DEFAULT 'linked' NOT NULL,
	"deposited_at" date,
	"status_changed_at" date,
	"description" text,
	"document_id" uuid,
	"origin" text DEFAULT 'manual' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "process_risk_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"classification" text NOT NULL,
	"percentage_bp" integer NOT NULL,
	"opinion" text NOT NULL,
	"effective_from" date NOT NULL,
	"status" text DEFAULT 'official' NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"rules_version" integer DEFAULT 1 NOT NULL,
	"assessed_by_id" uuid,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_valuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"base_date" date NOT NULL,
	"instance" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"is_estimate" boolean DEFAULT false NOT NULL,
	"reason" text,
	"document_id" uuid,
	"document_version_id" uuid,
	"page" integer,
	"excerpt" text,
	"confidence" integer,
	"import_batch_id" uuid,
	"brief_id" uuid,
	"supersedes_id" uuid,
	"created_by_id" uuid,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"settlement_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"due_date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"paid_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"status" text DEFAULT 'proposal' NOT NULL,
	"total_amount_cents" bigint,
	"installments_count" integer,
	"proposed_at" date,
	"signed_at" date,
	"homologated_at" date,
	"notes" text,
	"responsible_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "case_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_to_id" uuid,
	"assignment_method" text,
	"distribution_rule_id" uuid,
	"assigned_law_firm_id" uuid,
	"assigned_unit_id" uuid,
	"assignment_reason" text,
	"assigned_at" timestamp with time zone,
	"brief_id" uuid,
	"last_email_id" uuid,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distribution_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assignment" jsonb NOT NULL,
	"rr_cursor" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hearings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mode" text DEFAULT 'in_person' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"location" text,
	"meeting_url" text,
	"responsible_id" uuid,
	"notes" text,
	"outcome" text,
	"origin" text DEFAULT 'manual' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "case_brief_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"brief_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"content" jsonb NOT NULL,
	"edited_by_id" uuid,
	"change_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_brief_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"brief_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"source_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"version_id" uuid,
	"version_number" integer,
	"label" text NOT NULL,
	"content_hash" text NOT NULL,
	"page_count" integer,
	"char_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"intake_id" uuid,
	"version" integer NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"original_content" jsonb,
	"content" jsonb,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"requested_by_id" uuid,
	"generated_at" timestamp with time zone,
	"last_edited_by_id" uuid,
	"last_edited_at" timestamp with time zone,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"rejected_by_id" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"is_stale" boolean DEFAULT false NOT NULL,
	"stale_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"type" text NOT NULL,
	"detail" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"template" text NOT NULL,
	"status" text NOT NULL,
	"to_user_id" uuid,
	"to_name" text NOT NULL,
	"to_address" text NOT NULL,
	"from_name" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text NOT NULL,
	"link_url" text,
	"entity_type" text,
	"entity_id" uuid,
	"process_id" uuid,
	"brief_id" uuid,
	"intake_id" uuid,
	"provider_message_id" text,
	"error_message" text,
	"triggered_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid,
	"default_unit_id" uuid,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text,
	"status" text DEFAULT 'analyzed' NOT NULL,
	"sheets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mapping" jsonb,
	"stats" jsonb,
	"error_message" text,
	"created_by_id" uuid,
	"committed_by_id" uuid,
	"committed_at" timestamp with time zone,
	"rolled_back_by_id" uuid,
	"rolled_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"sheet" text NOT NULL,
	"row_number" integer NOT NULL,
	"cnj" text,
	"cnj_valid" boolean DEFAULT false NOT NULL,
	"action" text NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb NOT NULL,
	"normalized" jsonb,
	"process_id" uuid,
	"before" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "settings" SET DEFAULT '{"ai":{"monthlyTokenBudget":2000000,"maxInputChars":120000,"autoAnalyzeOnUpload":true},"alerts":{"upcomingDeadlineDays":7,"contractExpirationDays":60,"upcomingHearingDays":10,"installmentDueDays":10},"retention":{"closedRecordRetentionDays":1825,"auditLogRetentionDays":1825},"contingency":{"riskPercentages":{"remote":0,"possible":50,"probable":100},"confidenceThreshold":85,"idleGuaranteeDays":180,"rulesVersion":1},"email":{"mode":"simulated","senderName":"Praetor (simulação)","senderAddress":"nao-responda@praetor.invalid","notifyOnBriefReady":true,"notifyOnAssignment":true},"intake":{"autoAssign":true,"autoGenerateBrief":true,"autoNotify":true}}'::jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "law_firm_id" uuid;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "law_firm_id" uuid;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "instance" text;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "process_class" text;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "phase_detail" text;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "liquidated_amount_cents" bigint;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "risk_percentage_bp" integer;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "closure_reason" text;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "needs_verification" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "verification_note" text;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "last_movement_at" date;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "process_events" ADD COLUMN "cnj_movement_code" integer;--> statement-breakpoint
ALTER TABLE "process_events" ADD COLUMN "instance" text;--> statement-breakpoint
ALTER TABLE "process_parties" ADD COLUMN "liability_nature" text;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "page_count" integer;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "page_offsets" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "law_firms" ADD CONSTRAINT "law_firms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_instances" ADD CONSTRAINT "process_instances_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshot_items" ADD CONSTRAINT "portfolio_snapshot_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshot_items" ADD CONSTRAINT "portfolio_snapshot_items_snapshot_id_portfolio_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."portfolio_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshot_items" ADD CONSTRAINT "portfolio_snapshot_items_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshot_items" ADD CONSTRAINT "portfolio_snapshot_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshot_items" ADD CONSTRAINT "portfolio_snapshot_items_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_generated_by_id_users_id_fk" FOREIGN KEY ("generated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_guarantees" ADD CONSTRAINT "process_guarantees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_guarantees" ADD CONSTRAINT "process_guarantees_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_guarantees" ADD CONSTRAINT "process_guarantees_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_guarantees" ADD CONSTRAINT "process_guarantees_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_risk_assessments" ADD CONSTRAINT "process_risk_assessments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_risk_assessments" ADD CONSTRAINT "process_risk_assessments_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_risk_assessments" ADD CONSTRAINT "process_risk_assessments_assessed_by_id_users_id_fk" FOREIGN KEY ("assessed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_risk_assessments" ADD CONSTRAINT "process_risk_assessments_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_valuations" ADD CONSTRAINT "process_valuations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_valuations" ADD CONSTRAINT "process_valuations_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_valuations" ADD CONSTRAINT "process_valuations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_valuations" ADD CONSTRAINT "process_valuations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_valuations" ADD CONSTRAINT "process_valuations_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_installments" ADD CONSTRAINT "settlement_installments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_installments" ADD CONSTRAINT "settlement_installments_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_responsible_id_users_id_fk" FOREIGN KEY ("responsible_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_distribution_rule_id_distribution_rules_id_fk" FOREIGN KEY ("distribution_rule_id") REFERENCES "public"."distribution_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_assigned_law_firm_id_law_firms_id_fk" FOREIGN KEY ("assigned_law_firm_id") REFERENCES "public"."law_firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_assigned_unit_id_units_id_fk" FOREIGN KEY ("assigned_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_intakes" ADD CONSTRAINT "case_intakes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_rules" ADD CONSTRAINT "distribution_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_rules" ADD CONSTRAINT "distribution_rules_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearings" ADD CONSTRAINT "hearings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearings" ADD CONSTRAINT "hearings_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearings" ADD CONSTRAINT "hearings_responsible_id_users_id_fk" FOREIGN KEY ("responsible_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hearings" ADD CONSTRAINT "hearings_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_brief_revisions" ADD CONSTRAINT "case_brief_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_brief_revisions" ADD CONSTRAINT "case_brief_revisions_brief_id_case_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."case_briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_brief_revisions" ADD CONSTRAINT "case_brief_revisions_edited_by_id_users_id_fk" FOREIGN KEY ("edited_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_brief_sources" ADD CONSTRAINT "case_brief_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_brief_sources" ADD CONSTRAINT "case_brief_sources_brief_id_case_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."case_briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_briefs" ADD CONSTRAINT "case_briefs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_briefs" ADD CONSTRAINT "case_briefs_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_briefs" ADD CONSTRAINT "case_briefs_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_briefs" ADD CONSTRAINT "case_briefs_last_edited_by_id_users_id_fk" FOREIGN KEY ("last_edited_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_briefs" ADD CONSTRAINT "case_briefs_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_briefs" ADD CONSTRAINT "case_briefs_rejected_by_id_users_id_fk" FOREIGN KEY ("rejected_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_message_id_email_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_default_unit_id_units_id_fk" FOREIGN KEY ("default_unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_committed_by_id_users_id_fk" FOREIGN KEY ("committed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_rolled_back_by_id_users_id_fk" FOREIGN KEY ("rolled_back_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_org_name_uq" ON "companies" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "law_firms_org_name_uq" ON "law_firms" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "process_instances_process_instance_uq" ON "process_instances" USING btree ("process_id","instance");--> statement-breakpoint
CREATE INDEX "process_instances_org_idx" ON "process_instances" USING btree ("organization_id","instance");--> statement-breakpoint
CREATE INDEX "portfolio_snapshot_items_snapshot_idx" ON "portfolio_snapshot_items" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "portfolio_snapshot_items_process_idx" ON "portfolio_snapshot_items" USING btree ("process_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_snapshots_org_period_uq" ON "portfolio_snapshots" USING btree ("organization_id","period");--> statement-breakpoint
CREATE INDEX "process_guarantees_process_idx" ON "process_guarantees" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "process_risk_assessments_process_idx" ON "process_risk_assessments" USING btree ("process_id","effective_from");--> statement-breakpoint
CREATE INDEX "process_valuations_process_idx" ON "process_valuations" USING btree ("process_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "process_valuations_org_status_idx" ON "process_valuations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_installments_number_uq" ON "settlement_installments" USING btree ("settlement_id","number");--> statement-breakpoint
CREATE INDEX "settlement_installments_org_due_idx" ON "settlement_installments" USING btree ("organization_id","due_date");--> statement-breakpoint
CREATE INDEX "settlements_process_idx" ON "settlements" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "settlements_org_status_idx" ON "settlements" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "case_intakes_org_status_idx" ON "case_intakes" USING btree ("organization_id","status","received_at");--> statement-breakpoint
CREATE INDEX "case_intakes_process_idx" ON "case_intakes" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "distribution_rules_org_idx" ON "distribution_rules" USING btree ("organization_id","priority");--> statement-breakpoint
CREATE INDEX "hearings_org_scheduled_idx" ON "hearings" USING btree ("organization_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "hearings_process_idx" ON "hearings" USING btree ("process_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_brief_revisions_uq" ON "case_brief_revisions" USING btree ("brief_id","revision");--> statement-breakpoint
CREATE INDEX "case_brief_sources_brief_idx" ON "case_brief_sources" USING btree ("brief_id");--> statement-breakpoint
CREATE INDEX "case_brief_sources_entity_idx" ON "case_brief_sources" USING btree ("organization_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "case_briefs_process_version_uq" ON "case_briefs" USING btree ("process_id","version");--> statement-breakpoint
CREATE INDEX "case_briefs_org_status_idx" ON "case_briefs" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "email_events_message_idx" ON "email_events" USING btree ("message_id","created_at");--> statement-breakpoint
CREATE INDEX "email_messages_org_created_idx" ON "email_messages" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "email_messages_to_user_idx" ON "email_messages" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "email_messages_process_idx" ON "email_messages" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "import_batches_org_created_idx" ON "import_batches" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "import_rows_batch_idx" ON "import_rows" USING btree ("batch_id","sheet","row_number");--> statement-breakpoint
CREATE INDEX "import_rows_batch_action_idx" ON "import_rows" USING btree ("batch_id","action");--> statement-breakpoint
CREATE INDEX "import_rows_org_cnj_idx" ON "import_rows" USING btree ("organization_id","cnj");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_law_firm_id_law_firms_id_fk" FOREIGN KEY ("law_firm_id") REFERENCES "public"."law_firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD CONSTRAINT "legal_processes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD CONSTRAINT "legal_processes_law_firm_id_law_firms_id_fk" FOREIGN KEY ("law_firm_id") REFERENCES "public"."law_firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_processes_org_company_idx" ON "legal_processes" USING btree ("organization_id","company_id");--> statement-breakpoint
CREATE INDEX "legal_processes_org_court_idx" ON "legal_processes" USING btree ("organization_id","court");--> statement-breakpoint
CREATE INDEX "legal_processes_org_phase_idx" ON "legal_processes" USING btree ("organization_id","phase");--> statement-breakpoint
CREATE INDEX "legal_processes_law_firm_idx" ON "legal_processes" USING btree ("law_firm_id");