-- Together: a snapshot per user, a fresh sandbox on every wake.

ALTER TABLE "users" ADD COLUMN "snapshot_alias" text;--> statement-breakpoint
UPDATE "users" SET "snapshot_alias" = 'gali-user-' || "username" WHERE "snapshot_alias" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "snapshot_alias" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_snapshot_alias_unique" UNIQUE("snapshot_alias");--> statement-breakpoint

-- Prior sandbox ids cannot be resumed; wake always creates a new one.
ALTER TABLE "users" ALTER COLUMN "sandbox_id" DROP NOT NULL;--> statement-breakpoint
UPDATE "users" SET "sandbox_id" = NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wake_claim_at" timestamp with time zone;--> statement-breakpoint

-- Re-key notification idempotency off the (now transient) sandbox id.
DELETE FROM "session_notifications";--> statement-breakpoint
DROP INDEX IF EXISTS "session_notifications_sandbox_project_session";--> statement-breakpoint
ALTER TABLE "session_notifications" DROP COLUMN "sandbox_id";--> statement-breakpoint
ALTER TABLE "session_notifications" ADD COLUMN "user_id" integer NOT NULL REFERENCES "users"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_notifications_user_project_session" ON "session_notifications" USING btree ("user_id","project_key","session_id");
