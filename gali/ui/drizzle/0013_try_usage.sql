CREATE TABLE "try_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"voice_seconds" integer DEFAULT 0 NOT NULL,
	"answers" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "try_voice_calls" (
	"call_id" text PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
