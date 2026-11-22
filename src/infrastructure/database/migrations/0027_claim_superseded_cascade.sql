ALTER TABLE "claims" DROP CONSTRAINT "claims_superseded_by_claim_id_claims_claim_id_fk";
--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_superseded_by_claim_id_claims_claim_id_fk" FOREIGN KEY ("superseded_by_claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;