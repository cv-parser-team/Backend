ALTER TABLE "claims" ADD COLUMN "current" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "claims"
SET "current" = "extraction_current"
WHERE "origin" = 'extracted' AND "extraction_current" IS NOT NULL;
