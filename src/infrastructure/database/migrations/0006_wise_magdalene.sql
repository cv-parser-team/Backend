ALTER TYPE "public"."claim_type" ADD VALUE 'language';--> statement-breakpoint
ALTER TYPE "public"."claim_type" ADD VALUE 'project';--> statement-breakpoint
CREATE TABLE "language_details" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"proficiency" text
);
--> statement-breakpoint
CREATE TABLE "project_details" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"role" text,
	"url" text,
	"start_date" date,
	"end_date" date,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "project_details_dates_ordered" CHECK ("project_details"."start_date" is null or "project_details"."end_date" is null
        or "project_details"."end_date" >= "project_details"."start_date")
);
--> statement-breakpoint
ALTER TABLE "candidates" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD COLUMN "unmapped_data" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "language_details" ADD CONSTRAINT "language_details_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_details" ADD CONSTRAINT "project_details_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_details_skills_idx" ON "project_details" USING gin ("skills");