ALTER TABLE "process_valuations" ADD COLUMN "cleared_on" date;--> statement-breakpoint
CREATE INDEX "legal_processes_org_city_idx" ON "legal_processes" USING btree ("organization_id","city");--> statement-breakpoint
CREATE INDEX "legal_processes_org_class_idx" ON "legal_processes" USING btree ("organization_id","process_class");--> statement-breakpoint
CREATE INDEX "legal_processes_import_batch_idx" ON "legal_processes" USING btree ("organization_id","import_batch_id") WHERE "legal_processes"."import_batch_id" is not null;--> statement-breakpoint
CREATE INDEX "legal_processes_org_number_digits_idx" ON "legal_processes" USING btree ("organization_id",regexp_replace("number", '[^0-9]', '', 'g')) WHERE "legal_processes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "process_instances_import_batch_idx" ON "process_instances" USING btree ("organization_id","import_batch_id") WHERE "process_instances"."import_batch_id" is not null;--> statement-breakpoint
CREATE INDEX "process_valuations_import_batch_idx" ON "process_valuations" USING btree ("organization_id","import_batch_id") WHERE "process_valuations"."import_batch_id" is not null;