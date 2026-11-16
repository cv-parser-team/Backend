CREATE TYPE "public"."extraction_review_status" AS ENUM('pending', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TABLE "extraction_review_items" (
	"review_item_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"extraction_invocation_id" uuid NOT NULL,
	"claim_type" text NOT NULL,
	"fields" jsonb NOT NULL,
	"issues" jsonb NOT NULL,
	"sources" text[] NOT NULL,
	"fingerprint" text NOT NULL,
	"status" "extraction_review_status" DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_review_items_claim_type_valid" CHECK ("extraction_review_items"."claim_type" in ('skill', 'employment', 'education', 'certification', 'language', 'project')),
	CONSTRAINT "extraction_review_items_issues_not_empty" CHECK (jsonb_array_length("extraction_review_items"."issues") > 0),
	CONSTRAINT "extraction_review_items_fingerprint_not_blank" CHECK (length(btrim("extraction_review_items"."fingerprint")) > 0)
);
--> statement-breakpoint
ALTER TABLE "extraction_review_items" ADD CONSTRAINT "extraction_review_items_document_id_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extraction_review_items_document_status_idx" ON "extraction_review_items" USING btree ("document_id","status");