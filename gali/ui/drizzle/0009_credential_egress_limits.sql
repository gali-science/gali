CREATE TABLE "credential_egress_windows" (
	"binding_id" integer NOT NULL,
	"period" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"byte_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "credential_egress_windows_pk" PRIMARY KEY("binding_id","period","window_start")
);
--> statement-breakpoint
ALTER TABLE "credential_egress_windows" ADD CONSTRAINT "credential_egress_windows_binding_id_credential_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."credential_bindings"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "credential_egress_windows_start" ON "credential_egress_windows" USING btree ("window_start");
