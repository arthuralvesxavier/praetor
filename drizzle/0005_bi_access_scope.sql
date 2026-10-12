CREATE TABLE "bi_reader_roles" (
	"role_name" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bi_settings" ADD COLUMN "access_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bi_reader_roles" ADD CONSTRAINT "bi_reader_roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;