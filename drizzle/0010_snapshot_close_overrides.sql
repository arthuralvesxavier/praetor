CREATE TABLE "snapshot_close_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"unclassified_process_ids" jsonb NOT NULL,
	"unclassified_count" integer NOT NULL,
	"closed_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshot_close_overrides_reason_len" CHECK (char_length(btrim("snapshot_close_overrides"."reason")) >= 20),
	CONSTRAINT "snapshot_close_overrides_count_positive" CHECK ("snapshot_close_overrides"."unclassified_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "snapshot_close_overrides" ADD CONSTRAINT "snapshot_close_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_close_overrides" ADD CONSTRAINT "snapshot_close_overrides_snapshot_id_portfolio_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."portfolio_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_close_overrides" ADD CONSTRAINT "snapshot_close_overrides_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "snapshot_close_overrides_snapshot_uq" ON "snapshot_close_overrides" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "snapshot_close_overrides_org_idx" ON "snapshot_close_overrides" USING btree ("organization_id");