ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
CREATE TABLE "session_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"sandbox_id" text NOT NULL,
	"project_key" text NOT NULL,
	"session_id" integer NOT NULL,
	"status" text NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_notifications_sandbox_project_session" ON "session_notifications" USING btree ("sandbox_id","project_key","session_id");
