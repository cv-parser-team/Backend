CREATE TYPE "public"."normalization_ai_request_status" AS ENUM('queued', 'processing', 'completed', 'failed', 'superseded');--> statement-breakpoint
CREATE TABLE "normalization_ai_requests" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"category" "canonical_category" NOT NULL,
	"original_value" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preferred_term_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "normalization_ai_request_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "normalization_ai_requests" ADD CONSTRAINT "normalization_ai_requests_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "normalization_ai_requests_active_claim_unique" ON "normalization_ai_requests" USING btree ("claim_id") WHERE "normalization_ai_requests"."status" in ('queued', 'processing');--> statement-breakpoint
CREATE INDEX "normalization_ai_requests_runnable_idx" ON "normalization_ai_requests" USING btree ("status","available_at");