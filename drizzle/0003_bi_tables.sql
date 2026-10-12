CREATE TABLE "bi_labels" (
	"domain" text NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bi_labels_domain_code_pk" PRIMARY KEY("domain","code")
);
--> statement-breakpoint
CREATE TABLE "bi_process_access" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"user_key" text NOT NULL,
	"process_id" uuid NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bi_process_access_user_id_process_id_pk" PRIMARY KEY("user_id","process_id")
);
--> statement-breakpoint
CREATE TABLE "bi_refresh_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"dataset_id" text,
	"message" text,
	"request_id" text,
	"requested_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bi_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"reports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rls_role" text DEFAULT 'AcessoPraetor' NOT NULL,
	"auto_refresh" boolean DEFAULT true NOT NULL,
	"config_updated_at" timestamp with time zone,
	"config_updated_by_id" uuid,
	"access_refreshed_at" timestamp with time zone,
	"access_user_count" integer,
	"access_row_count" integer,
	"source_watermark_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bi_process_access" ADD CONSTRAINT "bi_process_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_process_access" ADD CONSTRAINT "bi_process_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_process_access" ADD CONSTRAINT "bi_process_access_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_refresh_runs" ADD CONSTRAINT "bi_refresh_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_refresh_runs" ADD CONSTRAINT "bi_refresh_runs_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_settings" ADD CONSTRAINT "bi_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bi_settings" ADD CONSTRAINT "bi_settings_config_updated_by_id_users_id_fk" FOREIGN KEY ("config_updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bi_process_access_org_idx" ON "bi_process_access" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bi_process_access_user_key_idx" ON "bi_process_access" USING btree ("user_key");--> statement-breakpoint
CREATE INDEX "bi_refresh_runs_org_created_idx" ON "bi_refresh_runs" USING btree ("organization_id","created_at");