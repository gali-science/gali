CREATE TABLE "voice_memories" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"transcript" text DEFAULT '' NOT NULL,
	"ui_location" text DEFAULT '' NOT NULL,
	"transcript_at" timestamp with time zone,
	"summarized_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_memories" ADD CONSTRAINT "voice_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
