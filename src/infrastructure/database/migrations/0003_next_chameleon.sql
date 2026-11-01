CREATE TYPE "public"."document_format" AS ENUM('pdf', 'docx');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "document_extractions" (
	"extraction_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"status" "extraction_status" NOT NULL,
	"format" "document_format" NOT NULL,
	"page_count" integer,
	"content" jsonb NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parser_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_extractions_page_count_positive" CHECK ("document_extractions"."page_count" is null or "document_extractions"."page_count" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "document_extractions_document_id_unique" ON "document_extractions" USING btree ("document_id");