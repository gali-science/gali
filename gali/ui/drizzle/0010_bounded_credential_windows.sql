ALTER TABLE "credential_egress_windows" DROP CONSTRAINT "credential_egress_windows_pk";
--> statement-breakpoint
ALTER TABLE "credential_egress_windows" ADD CONSTRAINT "credential_egress_windows_pk" PRIMARY KEY("binding_id","period");
