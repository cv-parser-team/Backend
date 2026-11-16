CREATE TABLE "claim_pair_decisions" (
	"decision_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"left_claim_id" uuid NOT NULL,
	"right_claim_id" uuid NOT NULL,
	"left_version" integer NOT NULL,
	"right_version" integer NOT NULL,
	"decision" text DEFAULT 'different' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_pair_decisions_claims_ordered" CHECK ("claim_pair_decisions"."left_claim_id" < "claim_pair_decisions"."right_claim_id"),
	CONSTRAINT "claim_pair_decisions_versions_positive" CHECK ("claim_pair_decisions"."left_version" > 0 and "claim_pair_decisions"."right_version" > 0),
	CONSTRAINT "claim_pair_decisions_decision_valid" CHECK ("claim_pair_decisions"."decision" = 'different')
);
--> statement-breakpoint
ALTER TABLE "claim_pair_decisions" ADD CONSTRAINT "claim_pair_decisions_candidate_id_candidates_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("candidate_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_pair_decisions" ADD CONSTRAINT "claim_pair_decisions_left_claim_id_claims_claim_id_fk" FOREIGN KEY ("left_claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_pair_decisions" ADD CONSTRAINT "claim_pair_decisions_right_claim_id_claims_claim_id_fk" FOREIGN KEY ("right_claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "claim_pair_decisions_candidate_pair_unique" ON "claim_pair_decisions" USING btree ("candidate_id","left_claim_id","right_claim_id");--> statement-breakpoint
CREATE INDEX "claim_pair_decisions_left_claim_id_idx" ON "claim_pair_decisions" USING btree ("left_claim_id");--> statement-breakpoint
CREATE INDEX "claim_pair_decisions_right_claim_id_idx" ON "claim_pair_decisions" USING btree ("right_claim_id");