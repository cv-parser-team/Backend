DROP INDEX "documents_owner_sha256_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "documents_owner_purpose_sha256_unique" ON "documents" USING btree ("owner_user_id","purpose","sha256");