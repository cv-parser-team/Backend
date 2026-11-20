CREATE TYPE "public"."claim_auto_merge_notice_status" AS ENUM('pending', 'acknowledged');--> statement-breakpoint
ALTER TYPE "public"."claim_status" ADD VALUE 'auto_accepted' BEFORE 'rejected';--> statement-breakpoint
CREATE TABLE "claim_auto_merge_notices" (
	"notice_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"survivor_claim_id" uuid NOT NULL,
	"superseded_claim_ids" uuid[] NOT NULL,
	"messages" text[] NOT NULL,
	"status" "claim_auto_merge_notice_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "claim_auto_merge_notices_superseded_not_empty" CHECK (cardinality("claim_auto_merge_notices"."superseded_claim_ids") > 0),
	CONSTRAINT "claim_auto_merge_notices_messages_not_empty" CHECK (cardinality("claim_auto_merge_notices"."messages") > 0)
);--> statement-breakpoint
ALTER TABLE "claim_auto_merge_notices" ADD CONSTRAINT "claim_auto_merge_notices_candidate_id_candidates_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("candidate_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_auto_merge_notices" ADD CONSTRAINT "claim_auto_merge_notices_survivor_claim_id_claims_claim_id_fk" FOREIGN KEY ("survivor_claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_auto_merge_notices_candidate_id_idx" ON "claim_auto_merge_notices" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "claim_auto_merge_notices_survivor_status_idx" ON "claim_auto_merge_notices" USING btree ("survivor_claim_id", "status");
