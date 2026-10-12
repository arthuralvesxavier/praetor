CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_id" uuid,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "court_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source" text DEFAULT 'datajud' NOT NULL,
	"tribunal_alias" text NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"checked" integer DEFAULT 0 NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"not_found" integer DEFAULT 0 NOT NULL,
	"new_movements" integer DEFAULT 0 NOT NULL,
	"phase_changes" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "court_sync_states" (
	"process_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"source" text DEFAULT 'datajud' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_found_at" timestamp with time zone,
	"remote_updated_at" timestamp with time zone,
	"instances_found" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"next_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"idempotency_key" text,
	"request_hash" text,
	"endpoint" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"process_id" uuid,
	"intake_id" uuid,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "settings" SET DEFAULT '{"ai":{"monthlyTokenBudget":2000000,"maxInputChars":120000,"autoAnalyzeOnUpload":true},"alerts":{"upcomingDeadlineDays":7,"contractExpirationDays":60,"upcomingHearingDays":10,"installmentDueDays":10},"retention":{"closedRecordRetentionDays":1825,"auditLogRetentionDays":1825},"contingency":{"riskPercentages":{"remote":0,"possible":50,"probable":100},"confidenceThreshold":85,"idleGuaranteeDays":180,"rulesVersion":1},"email":{"mode":"simulated","senderName":"Praetor (simulação)","senderAddress":"nao-responda@praetor.invalid","notifyOnBriefReady":true,"notifyOnAssignment":true},"intake":{"autoAssign":true,"autoGenerateBrief":true,"autoNotify":true},"integrations":{"datajud":{"enabled":true,"syncIntervalHours":24,"maxRequestsPerMinute":20,"batchSize":50,"autoApplyPhase":true,"enrichOnIntake":true},"simulatedFeed":{"enabled":false,"intervalMinutes":120}}}'::jsonb;--> statement-breakpoint
ALTER TABLE "legal_processes" ADD COLUMN "subjects" jsonb;--> statement-breakpoint
ALTER TABLE "process_events" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_revoked_by_id_users_id_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_sync_runs" ADD CONSTRAINT "court_sync_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_sync_states" ADD CONSTRAINT "court_sync_states_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "court_sync_states" ADD CONSTRAINT "court_sync_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_requests" ADD CONSTRAINT "inbound_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_requests" ADD CONSTRAINT "inbound_requests_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_requests" ADD CONSTRAINT "inbound_requests_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "court_sync_runs_org_alias_idx" ON "court_sync_runs" USING btree ("organization_id","tribunal_alias","started_at");--> statement-breakpoint
CREATE INDEX "court_sync_states_org_next_idx" ON "court_sync_states" USING btree ("organization_id","next_check_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_requests_key_idempotency_uq" ON "inbound_requests" USING btree ("api_key_id","idempotency_key") WHERE "inbound_requests"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "inbound_requests_org_created_idx" ON "inbound_requests" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "process_events_external_uq" ON "process_events" USING btree ("process_id","external_source","external_id") WHERE "process_events"."external_id" is not null;