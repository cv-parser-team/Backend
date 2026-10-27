CREATE TYPE "public"."claim_origin" AS ENUM('manual', 'extracted');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."claim_type" AS ENUM('skill', 'employment', 'education', 'certification');--> statement-breakpoint
CREATE TYPE "public"."claim_value_status" AS ENUM('current', 'superseded');--> statement-breakpoint
CREATE TABLE "candidates" (
	"candidate_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"headline" text,
	"summary" text,
	"phone" text,
	"location" text,
	"profile_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_full_name_not_blank" CHECK (length(btrim("candidates"."full_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "claim_value_history" (
	"value_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"field_name" text NOT NULL,
	"value" jsonb NOT NULL,
	"value_status" "claim_value_status" DEFAULT 'current' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_value_history_field_name_not_blank" CHECK (length(btrim("claim_value_history"."field_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"claim_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"claim_type" "claim_type" NOT NULL,
	"origin" "claim_origin" NOT NULL,
	"status" "claim_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_value_history" ADD CONSTRAINT "claim_value_history_claim_id_claims_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("claim_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_candidate_id_candidates_candidate_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("candidate_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_user_id_unique" ON "candidates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "claim_value_history_claim_id_idx" ON "claim_value_history" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "claim_value_history_current_field_unique" ON "claim_value_history" USING btree ("claim_id","field_name") WHERE "claim_value_history"."value_status" = 'current';--> statement-breakpoint
CREATE INDEX "claims_candidate_id_idx" ON "claims" USING btree ("candidate_id");