CREATE INDEX "try_voice_calls_open" ON "try_voice_calls" USING btree ("started_at") WHERE "try_voice_calls"."ended_at" is null;
