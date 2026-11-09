ALTER TABLE "users" ADD COLUMN "wake_failure" jsonb;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wake_failure_at" timestamp with time zone;
