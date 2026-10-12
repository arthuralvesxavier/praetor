CREATE TABLE "index_series" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sgs_code" integer NOT NULL,
	"last_month" text,
	"last_fetched_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "index_series_values" (
	"index_code" text NOT NULL,
	"month" text NOT NULL,
	"rate_percent" numeric(14, 6) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "index_series_values_index_code_month_pk" PRIMARY KEY("index_code","month")
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "settings" SET DEFAULT '{"ai":{"monthlyTokenBudget":2000000,"maxInputChars":120000,"autoAnalyzeOnUpload":true},"alerts":{"upcomingDeadlineDays":7,"contractExpirationDays":60,"upcomingHearingDays":10,"installmentDueDays":10},"retention":{"closedRecordRetentionDays":1825,"auditLogRetentionDays":1825},"contingency":{"riskPercentages":{"remote":0,"possible":50,"probable":100},"confidenceThreshold":85,"idleGuaranteeDays":180,"rulesVersion":1,"defaultCorrectionIndex":"none"},"email":{"mode":"simulated","senderName":"Praetor (simulação)","senderAddress":"nao-responda@praetor.invalid","notifyOnBriefReady":true,"notifyOnAssignment":true},"intake":{"autoAssign":true,"autoGenerateBrief":true,"autoNotify":true},"integrations":{"datajud":{"enabled":true,"syncIntervalHours":24,"maxRequestsPerMinute":20,"batchSize":50,"autoApplyPhase":true,"enrichOnIntake":true},"simulatedFeed":{"enabled":false,"intervalMinutes":120}}}'::jsonb;--> statement-breakpoint
ALTER TABLE "process_valuations" ADD COLUMN "correction_index" text;--> statement-breakpoint
ALTER TABLE "index_series_values" ADD CONSTRAINT "index_series_values_index_code_index_series_code_fk" FOREIGN KEY ("index_code") REFERENCES "public"."index_series"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- P1.7: new valuations get the organization's default correction index when the insert does not
-- set one (covers every insert path: contingency, processes, imports, seeds). Rows that existed
-- before this migration stay NULL ("sem índice informado"). The updated value is never stored.
CREATE OR REPLACE FUNCTION "process_valuations_default_correction_index"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chosen text;
BEGIN
  IF NEW."correction_index" IS NULL THEN
    SELECT o."settings" -> 'contingency' ->> 'defaultCorrectionIndex' INTO chosen
      FROM "organizations" o
     WHERE o."id" = NEW."organization_id";
    IF chosen IS NULL OR chosen NOT IN ('ipca_e', 'ipca', 'inpc', 'selic', 'tr', 'none') THEN
      chosen := 'none';
    END IF;
    NEW."correction_index" := chosen;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "process_valuations_default_correction_index"
  BEFORE INSERT ON "process_valuations"
  FOR EACH ROW EXECUTE FUNCTION "process_valuations_default_correction_index"();
