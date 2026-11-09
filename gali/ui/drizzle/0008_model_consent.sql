ALTER TABLE "users" ADD COLUMN "consent_version" integer;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "voice_openai_accepted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "experiments_together_accepted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_accepted_at" timestamp with time zone;
