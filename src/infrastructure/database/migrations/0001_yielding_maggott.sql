CREATE TABLE "auth_token_versions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_token_versions_nonnegative" CHECK ("auth_token_versions"."version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "auth_token_versions" ADD CONSTRAINT "auth_token_versions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "auth_token_versions" ("user_id")
SELECT "user_id" FROM "users"
ON CONFLICT ("user_id") DO NOTHING;
