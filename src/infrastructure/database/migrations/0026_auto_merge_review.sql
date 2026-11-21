ALTER TYPE "public"."claim_auto_merge_notice_status" ADD VALUE 'reverted';--> statement-breakpoint
ALTER TABLE "claim_auto_merge_notices" ADD COLUMN "claims_before" jsonb;
