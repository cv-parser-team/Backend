CREATE TABLE "source_occurrences" (
	"occurrence_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"anchor_key" text NOT NULL,
	"source_references" text[] NOT NULL,
	"field_names" text[] NOT NULL,
	"anchor" jsonb NOT NULL,
	CONSTRAINT "source_occurrences_anchor_key_not_blank" CHECK (length(btrim("source_occurrences"."anchor_key")) > 0),
	CONSTRAINT "source_occurrences_references_not_empty" CHECK (cardinality("source_occurrences"."source_references") > 0),
	CONSTRAINT "source_occurrences_fields_not_empty" CHECK (cardinality("source_occurrences"."field_names") > 0)
);
--> statement-breakpoint
ALTER TABLE "source_occurrences" ADD CONSTRAINT "source_occurrences_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_occurrences" ADD CONSTRAINT "source_occurrences_document_id_documents_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_occurrences_claim_anchor_unique" ON "source_occurrences" USING btree ("claim_id","anchor_key");--> statement-breakpoint
CREATE INDEX "source_occurrences_document_id_idx" ON "source_occurrences" USING btree ("document_id");