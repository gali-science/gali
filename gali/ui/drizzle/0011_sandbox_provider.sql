ALTER TABLE "users" ADD COLUMN "sandbox_provider" text DEFAULT 'together' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "sandbox_provider" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "snapshot_alias" TO "sandbox_home";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "sandbox_home" DROP NOT NULL;
