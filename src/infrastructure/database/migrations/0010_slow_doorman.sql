ALTER TABLE "candidates" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;