CREATE TYPE "public"."document_purpose" AS ENUM('source', 'evidence');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('stored', 'processing', 'ready', 'failed', 'deleting');--> statement-breakpoint
CREATE TABLE "documents" (
	"document_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"purpose" "document_purpose" NOT NULL,
	"original_filename" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"status" "document_status" DEFAULT 'stored' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_byte_size_positive" CHECK ("documents"."byte_size" > 0),
	CONSTRAINT "documents_original_filename_length" CHECK (length(btrim("documents"."original_filename")) between 1 and 255),
	CONSTRAINT "documents_sha256_format" CHECK ("documents"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "documents_storage_key_not_blank" CHECK (length(btrim("documents"."storage_key")) > 0),
	CONSTRAINT "documents_media_type_supported" CHECK ("documents"."media_type" in (
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'image/jpeg',
                'image/png'
            )),
	CONSTRAINT "documents_purpose_media_type_compatible" CHECK ("documents"."purpose" = 'evidence' or "documents"."media_type" in (
                'application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            )),
	CONSTRAINT "documents_failure_code_status" CHECK ((
                "documents"."status" = 'failed' and "documents"."failure_code" is not null
            ) or (
                "documents"."status" <> 'failed' and "documents"."failure_code" is null
            ))
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_user_id_users_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_storage_key_unique" ON "documents" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "documents_owner_created_at_idx" ON "documents" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_owner_sha256_idx" ON "documents" USING btree ("owner_user_id","sha256");