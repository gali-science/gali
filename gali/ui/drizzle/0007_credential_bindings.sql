CREATE TABLE "credential_bindings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"env_name" text NOT NULL,
	"upstream_origin" text NOT NULL,
	"allowed_path_prefix" text DEFAULT '/' NOT NULL,
	"auth_header" text DEFAULT 'Authorization' NOT NULL,
	"auth_prefix" text DEFAULT 'Bearer ' NOT NULL,
	"base_url_env_name" text,
	"encrypted_value" jsonb NOT NULL,
	"last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credential_bindings" ADD CONSTRAINT "credential_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "credential_bindings_user_env" ON "credential_bindings" USING btree ("user_id","env_name");
--> statement-breakpoint
CREATE INDEX "credential_bindings_user" ON "credential_bindings" USING btree ("user_id");
