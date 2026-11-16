CREATE TYPE "public"."llm_invocation_status" AS ENUM('started', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "llm_invocations" (
	"invocation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"contract_version" integer NOT NULL,
	"status" "llm_invocation_status" DEFAULT 'started' NOT NULL,
	"provider_request_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"error_category" text,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "llm_invocations_contract_version_positive" CHECK ("llm_invocations"."contract_version" > 0),
	CONSTRAINT "llm_invocations_input_tokens_nonnegative" CHECK ("llm_invocations"."input_tokens" is null or "llm_invocations"."input_tokens" >= 0),
	CONSTRAINT "llm_invocations_output_tokens_nonnegative" CHECK ("llm_invocations"."output_tokens" is null or "llm_invocations"."output_tokens" >= 0),
	CONSTRAINT "llm_invocations_completion_order" CHECK ("llm_invocations"."completed_at" is null or "llm_invocations"."completed_at" >= "llm_invocations"."started_at")
);
--> statement-breakpoint
CREATE INDEX "llm_invocations_operation_id_idx" ON "llm_invocations" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "llm_invocations_task_started_at_idx" ON "llm_invocations" USING btree ("task","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_invocations_provider_request_id_unique" ON "llm_invocations" USING btree ("provider","provider_request_id") WHERE "llm_invocations"."provider_request_id" is not null;