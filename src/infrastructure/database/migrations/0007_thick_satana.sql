CREATE TYPE "public"."actor_type" AS ENUM('system', 'ai', 'candidate', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."alias_origin" AS ENUM('seed', 'ai', 'candidate', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."alias_scope" AS ENUM('global', 'candidate');--> statement-breakpoint
CREATE TYPE "public"."alias_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."canonical_category" AS ENUM('skill', 'job_title', 'degree');--> statement-breakpoint
CREATE TYPE "public"."canonical_status" AS ENUM('active', 'merged');--> statement-breakpoint
CREATE TYPE "public"."normalization_method" AS ENUM('canonical', 'alias', 'fuzzy', 'ai', 'candidate');--> statement-breakpoint
CREATE TYPE "public"."normalization_status" AS ENUM('matched', 'unmatched', 'ambiguous');--> statement-breakpoint
CREATE TABLE "aliases" (
	"alias_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" uuid NOT NULL,
	"alias_text" text NOT NULL,
	"match_key" text NOT NULL,
	"scope" "alias_scope" DEFAULT 'global' NOT NULL,
	"origin" "alias_origin" NOT NULL,
	"status" "alias_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_terms" (
	"term_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" "canonical_category" NOT NULL,
	"canonical_name" text NOT NULL,
	"match_key" text NOT NULL,
	"status" "canonical_status" DEFAULT 'active' NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "normalization_decisions" (
	"normalization_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"term_id" uuid,
	"original_value" text NOT NULL,
	"method" "normalization_method",
	"confidence_score" numeric(3, 2),
	"actor_type" "actor_type" NOT NULL,
	"rule_version" text NOT NULL,
	"status" "normalization_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_term_id_canonical_terms_term_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."canonical_terms"("term_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_terms" ADD CONSTRAINT "canonical_terms_merged_into_id_canonical_terms_term_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."canonical_terms"("term_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalization_decisions" ADD CONSTRAINT "normalization_decisions_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "normalization_decisions" ADD CONSTRAINT "normalization_decisions_term_id_canonical_terms_term_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."canonical_terms"("term_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aliases_term_id_match_key_unique" ON "aliases" USING btree ("term_id","match_key");--> statement-breakpoint
CREATE INDEX "aliases_match_key_idx" ON "aliases" USING btree ("match_key");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_terms_category_match_key_unique" ON "canonical_terms" USING btree ("category","match_key");--> statement-breakpoint
CREATE INDEX "normalization_decisions_claim_id_idx" ON "normalization_decisions" USING btree ("claim_id","created_at");