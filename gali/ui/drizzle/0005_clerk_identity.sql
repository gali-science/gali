TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_username_unique";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "username";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "email";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "clerk_user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "identity_email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notification_email" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id");
