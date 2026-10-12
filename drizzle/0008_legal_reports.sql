CREATE TABLE "legal_report_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"section" text NOT NULL,
	"position" integer NOT NULL,
	"content" text NOT NULL,
	"origin" text NOT NULL,
	"document_id" uuid,
	"document_version_id" uuid,
	"page" integer,
	"excerpt" text,
	"record_source" jsonb,
	"derived_from" jsonb,
	"confidence" integer,
	"simulated" boolean DEFAULT false NOT NULL,
	"pending_reason" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_report_items_origin_ck" CHECK ("legal_report_items"."origin" in ('documented', 'record', 'inference', 'analysis', 'gap')),
	CONSTRAINT "legal_report_items_confidence_ck" CHECK ("legal_report_items"."confidence" is null or ("legal_report_items"."confidence" between 0 and 100))
);
--> statement-breakpoint
CREATE TABLE "legal_report_sequences" (
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"year" integer NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "legal_report_sequences_organization_id_type_year_pk" PRIMARY KEY("organization_id","type","year")
);
--> statement-breakpoint
CREATE TABLE "legal_report_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"report_id" uuid NOT NULL,
	"item_id" uuid,
	"reference" text NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"document_id" uuid,
	"document_version_id" uuid,
	"page" integer,
	"document_sha256" text,
	"sensitive" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"confirmed" boolean NOT NULL,
	"not_confirmed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_report_sources_reason_ck" CHECK ("legal_report_sources"."confirmed" or "legal_report_sources"."not_confirmed_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "legal_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"reference" text NOT NULL,
	"reference_year" integer NOT NULL,
	"reference_number" integer NOT NULL,
	"title" text NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL,
	"scope" jsonb NOT NULL,
	"process_id" uuid,
	"base_date" date NOT NULL,
	"parameters" jsonb NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"generated_by_id" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"pdf_storage_key" text,
	"pdf_sha256" text,
	"pdf_size_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_reports_status_ck" CHECK ("legal_reports"."status" in ('draft', 'pending_review', 'approved', 'superseded')),
	CONSTRAINT "legal_reports_version_ck" CHECK ("legal_reports"."version" >= 1),
	CONSTRAINT "legal_reports_approved_ck" CHECK ("legal_reports"."status" <> 'approved' or ("legal_reports"."approved_by_id" is not null and "legal_reports"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "process_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"process_id" uuid NOT NULL,
	"description" text NOT NULL,
	"probability_band" text NOT NULL,
	"percent_min" integer NOT NULL,
	"percent_max" integer NOT NULL,
	"comment" text,
	"origin" text NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "process_scenarios_percent_ck" CHECK ("process_scenarios"."percent_min" >= 0 and "process_scenarios"."percent_max" <= 100 and "process_scenarios"."percent_min" <= "process_scenarios"."percent_max"),
	CONSTRAINT "process_scenarios_band_ck" CHECK ("process_scenarios"."probability_band" in ('very_high', 'high', 'moderate', 'low', 'very_low')),
	CONSTRAINT "process_scenarios_origin_ck" CHECK ("process_scenarios"."origin" in ('system', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "settings" SET DEFAULT '{"ai":{"monthlyTokenBudget":2000000,"maxInputChars":120000,"autoAnalyzeOnUpload":true},"alerts":{"upcomingDeadlineDays":7,"contractExpirationDays":60,"upcomingHearingDays":10,"installmentDueDays":10},"retention":{"closedRecordRetentionDays":1825,"auditLogRetentionDays":1825},"contingency":{"riskPercentages":{"remote":0,"possible":50,"probable":100},"confidenceThreshold":85,"idleGuaranteeDays":180,"rulesVersion":1,"defaultCorrectionIndex":"none"},"email":{"mode":"simulated","senderName":"Praetor (simulação)","senderAddress":"nao-responda@praetor.invalid","notifyOnBriefReady":true,"notifyOnAssignment":true},"intake":{"autoAssign":true,"autoGenerateBrief":true,"autoNotify":true},"integrations":{"datajud":{"enabled":true,"syncIntervalHours":24,"maxRequestsPerMinute":20,"batchSize":50,"autoApplyPhase":true,"enrichOnIntake":true},"simulatedFeed":{"enabled":false,"intervalMinutes":120}},"legalReports":{"confidenceThreshold":70,"bands":{"very_high":{"min":80,"max":100},"high":{"min":60,"max":80},"moderate":{"min":40,"max":60},"low":{"min":20,"max":40},"very_low":{"min":0,"max":20}},"legalBasisText":"Exercício regular de direitos em processo judicial e cumprimento de obrigação legal (LGPD)"}}'::jsonb;--> statement-breakpoint
ALTER TABLE "legal_report_items" ADD CONSTRAINT "legal_report_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_report_items" ADD CONSTRAINT "legal_report_items_report_id_legal_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."legal_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_report_items" ADD CONSTRAINT "legal_report_items_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_report_items" ADD CONSTRAINT "legal_report_items_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_report_sequences" ADD CONSTRAINT "legal_report_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_report_sources" ADD CONSTRAINT "legal_report_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_report_sources" ADD CONSTRAINT "legal_report_sources_report_id_legal_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."legal_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_report_sources" ADD CONSTRAINT "legal_report_sources_item_id_legal_report_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."legal_report_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_report_sources" ADD CONSTRAINT "legal_report_sources_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_report_sources" ADD CONSTRAINT "legal_report_sources_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_reports" ADD CONSTRAINT "legal_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_reports" ADD CONSTRAINT "legal_reports_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_reports" ADD CONSTRAINT "legal_reports_supersedes_id_legal_reports_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."legal_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_reports" ADD CONSTRAINT "legal_reports_generated_by_id_users_id_fk" FOREIGN KEY ("generated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_reports" ADD CONSTRAINT "legal_reports_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_scenarios" ADD CONSTRAINT "process_scenarios_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_scenarios" ADD CONSTRAINT "process_scenarios_process_id_legal_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."legal_processes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "process_scenarios" ADD CONSTRAINT "process_scenarios_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_report_items_report_idx" ON "legal_report_items" USING btree ("report_id","section","position");--> statement-breakpoint
CREATE INDEX "legal_report_items_document_idx" ON "legal_report_items" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "legal_report_sources_report_idx" ON "legal_report_sources" USING btree ("report_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_reports_org_reference_version_uq" ON "legal_reports" USING btree ("organization_id","reference","version");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_reports_supersedes_uq" ON "legal_reports" USING btree ("supersedes_id");--> statement-breakpoint
CREATE INDEX "legal_reports_org_generated_idx" ON "legal_reports" USING btree ("organization_id","generated_at");--> statement-breakpoint
CREATE INDEX "legal_reports_process_idx" ON "legal_reports" USING btree ("process_id");--> statement-breakpoint
CREATE INDEX "process_scenarios_process_idx" ON "process_scenarios" USING btree ("process_id","created_at");--> statement-breakpoint
-- Relatórios jurídicos: imutabilidade garantida também no banco. Um relatório emitido nunca muda de
-- conteúdo; depois de aprovado só pode passar a "superseded" (nova versão), sem mudar mais nada.
-- Nenhum relatório é excluído. Itens, fontes e cenários são somente de inclusão.
CREATE OR REPLACE FUNCTION "legal_reports_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legal_reports: relatórios não são excluídos' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('approved', 'superseded') THEN
    IF OLD."status" = 'approved' AND NEW."status" = 'superseded'
       AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'legal_reports: relatório aprovado ou substituído é imutável (gere nova versão)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."reference_year" IS DISTINCT FROM OLD."reference_year"
     OR NEW."reference_number" IS DISTINCT FROM OLD."reference_number"
     OR NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."is_sample" IS DISTINCT FROM OLD."is_sample"
     OR NEW."scope" IS DISTINCT FROM OLD."scope"
     OR NEW."process_id" IS DISTINCT FROM OLD."process_id"
     OR NEW."base_date" IS DISTINCT FROM OLD."base_date"
     OR NEW."parameters" IS DISTINCT FROM OLD."parameters"
     OR NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."supersedes_id" IS DISTINCT FROM OLD."supersedes_id"
     OR NEW."generated_by_id" IS DISTINCT FROM OLD."generated_by_id"
     OR NEW."generated_at" IS DISTINCT FROM OLD."generated_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'legal_reports: o conteúdo de um relatório emitido não muda (gere nova versão)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "legal_reports_guard"
  BEFORE UPDATE OR DELETE ON "legal_reports"
  FOR EACH ROW EXECUTE FUNCTION "legal_reports_guard"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "legal_reports_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: registros somente de inclusão (não são alterados nem excluídos)', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "legal_report_items_append_only"
  BEFORE UPDATE OR DELETE ON "legal_report_items"
  FOR EACH ROW EXECUTE FUNCTION "legal_reports_append_only"();
--> statement-breakpoint
CREATE TRIGGER "legal_report_sources_append_only"
  BEFORE UPDATE OR DELETE ON "legal_report_sources"
  FOR EACH ROW EXECUTE FUNCTION "legal_reports_append_only"();
--> statement-breakpoint
CREATE TRIGGER "process_scenarios_append_only"
  BEFORE UPDATE OR DELETE ON "process_scenarios"
  FOR EACH ROW EXECUTE FUNCTION "legal_reports_append_only"();
