CREATE TYPE "public"."processing_job_status" AS ENUM('queued', 'processing', 'retrying', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "document_processing_jobs" (
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"status" "processing_job_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_processing_jobs_attempt_count_nonnegative" CHECK ("document_processing_jobs"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_processing_jobs" ADD CONSTRAINT "document_processing_jobs_document_id_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_processing_jobs_runnable_idx" ON "document_processing_jobs" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "document_processing_jobs_lease_idx" ON "document_processing_jobs" USING btree ("status","locked_until");--> statement-breakpoint
CREATE INDEX "document_processing_jobs_document_id_idx" ON "document_processing_jobs" USING btree ("document_id");