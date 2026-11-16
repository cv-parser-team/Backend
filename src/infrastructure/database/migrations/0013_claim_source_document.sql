ALTER TABLE "claims" DROP CONSTRAINT "claims_extraction_metadata_matches_origin";--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "extraction_document_id" uuid;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_extraction_metadata_matches_origin" CHECK ((
        "claims"."origin" = 'manual'
        and "claims"."extraction_invocation_id" is null
        and "claims"."extraction_document_id" is null
        and "claims"."extraction_raw_values" is null
        and "claims"."extraction_field_sources" is null
        and "claims"."extraction_current" is null
      ) or (
        "claims"."origin" = 'extracted'
        and "claims"."extraction_invocation_id" is not null
        and "claims"."extraction_raw_values" is not null
        and "claims"."extraction_field_sources" is not null
        and "claims"."extraction_current" is not null
      ));