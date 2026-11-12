ALTER TABLE "claims" ADD COLUMN "extraction_invocation_id" uuid;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "extraction_raw_values" jsonb;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "extraction_field_sources" jsonb;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "extraction_current" boolean;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_extraction_metadata_matches_origin" CHECK ((
        "claims"."origin" = 'manual'
        and "claims"."extraction_invocation_id" is null
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