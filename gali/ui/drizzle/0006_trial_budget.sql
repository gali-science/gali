ALTER TABLE "users" ADD COLUMN "trial_spent_micros" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"model" text NOT NULL,
	"usage" jsonb NOT NULL,
	"cost_micros" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "trial_spend_alerts" (
	"period" text PRIMARY KEY NOT NULL,
	"spent_micros" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_user_source_external" ON "usage_events" USING btree ("user_id","source","external_id");--> statement-breakpoint
CREATE INDEX "usage_events_created_at" ON "usage_events" USING btree ("created_at");
