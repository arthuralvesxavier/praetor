CREATE TABLE "process_claim_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"classification" text NOT NULL,
	"percentage_bp" integer NOT NULL,
	"base_amount_cents" bigint,
	"base_date" date,
	"correction_index" text,
	"opinion" text NOT NULL,
	"effective_from" date NOT NULL,
	"rules_version" integer DEFAULT 1 NOT NULL,
	"assessed_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_claim_risk_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"risk_assessment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"derived_classification" text,
	"derived_percentage_bp" integer,
	"derived_provision_cents" bigint,
	"quantified_base_cents" bigint,
	"unquantified_count" integer DEFAULT 0 NOT NULL,
	"unassessed_count" integer DEFAULT 0 NOT NULL,
	"basis_fingerprint" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "process_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"description" text NOT NULL,
	"category" text,
	"claimed_amount_cents" bigint,
	"amount_base_date" date,
	"correction_index" text,
	"instance" text,
	"origin" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"source_brief_id" uuid,
	"source_index" integer,
	"source_note" text,
	"confirmed_by_id" uuid,
	"confirmed_at" timestamp with time zone,
	"dismissed_by_id" uuid,
	"dismissed_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "process_claim_assessments" ADD CONSTRAINT "process_claim_assessments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claim_assessments" ADD CONSTRAINT "process_claim_assessments_claim_id_process_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."process_claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claim_assessments" ADD CONSTRAINT "process_claim_assessments_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claim_assessments" ADD CONSTRAINT "process_claim_assessments_assessed_by_id_users_id_fk" FOREIGN KEY ("assessed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claim_risk_links" ADD CONSTRAINT "process_claim_risk_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claim_risk_links" ADD CONSTRAINT "process_claim_risk_links_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claim_risk_links" ADD CONSTRAINT "process_claim_risk_links_risk_assessment_id_process_risk_assessments_id_fk" FOREIGN KEY ("risk_assessment_id") REFERENCES "public"."process_risk_assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claim_risk_links" ADD CONSTRAINT "process_claim_risk_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claims" ADD CONSTRAINT "process_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claims" ADD CONSTRAINT "process_claims_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claims" ADD CONSTRAINT "process_claims_source_brief_id_case_briefs_id_fk" FOREIGN KEY ("source_brief_id") REFERENCES "public"."case_briefs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claims" ADD CONSTRAINT "process_claims_confirmed_by_id_users_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claims" ADD CONSTRAINT "process_claims_dismissed_by_id_users_id_fk" FOREIGN KEY ("dismissed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_claims" ADD CONSTRAINT "process_claims_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "process_claim_assessments_claim_idx" ON "process_claim_assessments" USING btree ("claim_id","effective_from");--> statement-breakpoint
CREATE INDEX "process_claim_assessments_process_idx" ON "process_claim_assessments" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "process_claim_risk_links_process_idx" ON "process_claim_risk_links" USING btree ("process_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "process_claim_risk_links_assessment_uq" ON "process_claim_risk_links" USING btree ("risk_assessment_id");--> statement-breakpoint
CREATE INDEX "process_claims_process_idx" ON "process_claims" USING btree ("process_id","created_at");--> statement-breakpoint
CREATE INDEX "process_claims_org_status_idx" ON "process_claims" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "process_claims_brief_item_uq" ON "process_claims" USING btree ("source_brief_id","source_index");