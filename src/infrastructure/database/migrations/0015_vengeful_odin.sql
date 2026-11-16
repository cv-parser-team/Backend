CREATE TYPE "public"."claim_date_precision" AS ENUM('year', 'month');--> statement-breakpoint
ALTER TABLE "certification_details" ADD COLUMN "issue_date_precision" "claim_date_precision" DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "certification_details" ADD COLUMN "expiry_date_precision" "claim_date_precision";--> statement-breakpoint
ALTER TABLE "education_details" ADD COLUMN "start_date_precision" "claim_date_precision" DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "education_details" ADD COLUMN "end_date_precision" "claim_date_precision";--> statement-breakpoint
ALTER TABLE "employment_details" ADD COLUMN "start_date_precision" "claim_date_precision" DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "employment_details" ADD COLUMN "end_date_precision" "claim_date_precision";--> statement-breakpoint
ALTER TABLE "project_details" ADD COLUMN "start_date_precision" "claim_date_precision";--> statement-breakpoint
ALTER TABLE "project_details" ADD COLUMN "end_date_precision" "claim_date_precision";--> statement-breakpoint
UPDATE "certification_details" SET "expiry_date_precision" = 'month' WHERE "expiry_date" IS NOT NULL;--> statement-breakpoint
UPDATE "education_details" SET "end_date_precision" = 'month' WHERE "end_date" IS NOT NULL;--> statement-breakpoint
UPDATE "employment_details" SET "end_date_precision" = 'month' WHERE "end_date" IS NOT NULL;--> statement-breakpoint
UPDATE "project_details" SET "start_date_precision" = 'month' WHERE "start_date" IS NOT NULL;--> statement-breakpoint
UPDATE "project_details" SET "end_date_precision" = 'month' WHERE "end_date" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "certification_details" ADD CONSTRAINT "certification_details_expiry_precision_matches_date" CHECK (("certification_details"."expiry_date" is null) = ("certification_details"."expiry_date_precision" is null));--> statement-breakpoint
ALTER TABLE "education_details" ADD CONSTRAINT "education_details_end_precision_matches_date" CHECK (("education_details"."end_date" is null) = ("education_details"."end_date_precision" is null));--> statement-breakpoint
ALTER TABLE "employment_details" ADD CONSTRAINT "employment_details_end_precision_matches_date" CHECK (("employment_details"."end_date" is null) = ("employment_details"."end_date_precision" is null));--> statement-breakpoint
ALTER TABLE "project_details" ADD CONSTRAINT "project_details_start_precision_matches_date" CHECK (("project_details"."start_date" is null) = ("project_details"."start_date_precision" is null));--> statement-breakpoint
ALTER TABLE "project_details" ADD CONSTRAINT "project_details_end_precision_matches_date" CHECK (("project_details"."end_date" is null) = ("project_details"."end_date_precision" is null));
