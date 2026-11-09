CREATE TABLE "try_spend" (
	"key" text PRIMARY KEY NOT NULL,
	"spent_micros" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "try_voice_calls" ADD COLUMN "person_key" text;
--> statement-breakpoint
ALTER TABLE "try_voice_calls" ADD COLUMN "ip_key" text;
--> statement-breakpoint
ALTER TABLE "try_voice_calls" ADD COLUMN "paid_seconds" integer;
