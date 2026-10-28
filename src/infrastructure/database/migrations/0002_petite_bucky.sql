CREATE TYPE "public"."claim_origin" AS ENUM('manual', 'extracted');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."claim_type" AS ENUM('skill', 'employment', 'education', 'certification');--> statement-breakpoint
CREATE TABLE "candidates" (
	"candidate_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"headline" text,
	"summary" text,
	"phone" text,
	"location" text,
	"profile_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_full_name_not_blank" CHECK (length(btrim("candidates"."full_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "certification_details" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"issuer" text NOT NULL,
	"issue_date" date NOT NULL,
	"expiry_date" date,
	"credential_id" text,
	CONSTRAINT "certification_details_dates_ordered" CHECK ("certification_details"."expiry_date" is null or "certification_details"."expiry_date" >= "certification_details"."issue_date")
);
--> statement-breakpoint
CREATE TABLE "claim_revisions" (
	"revision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"previous_values" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"claim_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"claim_type" "claim_type" NOT NULL,
	"origin" "claim_origin" NOT NULL,
	"status" "claim_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "education_details" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"institution" text NOT NULL,
	"degree" text NOT NULL,
	"field_of_study" text,
	"start_date" date NOT NULL,
	"end_date" date,
	CONSTRAINT "education_details_dates_ordered" CHECK ("education_details"."end_date" is null or "education_details"."end_date" >= "education_details"."start_date")
);
--> statement-breakpoint
CREATE TABLE "employment_details" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"employer" text NOT NULL,
	"job_title" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"location" text,
	"description" text,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "employment_details_dates_ordered" CHECK ("employment_details"."end_date" is null or "employment_details"."end_date" >= "employment_details"."start_date")
);
--> statement-breakpoint
CREATE TABLE "skill_details" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certification_details" ADD CONSTRAINT "certification_details_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_revisions" ADD CONSTRAINT "claim_revisions_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_candidate_id_candidates_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("candidate_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "education_details" ADD CONSTRAINT "education_details_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_details" ADD CONSTRAINT "employment_details_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_details" ADD CONSTRAINT "skill_details_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_user_id_unique" ON "candidates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "claim_revisions_claim_id_idx" ON "claim_revisions" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "claims_candidate_id_idx" ON "claims" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "employment_details_skills_idx" ON "employment_details" USING gin ("skills");--> statement-breakpoint
CREATE INDEX "skill_details_name_lower_idx" ON "skill_details" USING btree (lower("name"));