import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SandboxFailure, SandboxProviderKind } from "../sandbox-provider/types.js";

// Control-plane only: accounts + where each one's sandbox lives. Deliberately
// separate from gali/src/db/schema.ts, which lives inside a single sandbox and has
// no user concept at all — isolation between users is "different sandbox", not a
// column in that schema.
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").unique().notNull(),
  identityEmail: text("identity_email").notNull(),
  displayName: text("display_name").notNull(),
  // Which provider holds this user's disk. Fixed for the life of the home.
  sandboxProvider: text("sandbox_provider").$type<SandboxProviderKind>().notNull(),
  // The durable identity: the provider's handle on this user's disk (a Vercel
  // sandbox name). Null until the first wake.
  sandboxHome: text("sandbox_home"),
  // Which sandbox is awake right now, if any. Null while asleep.
  sandboxId: text("sandbox_id"),
  // Public Gali ingress from the provider's authenticated response. The proxy
  // trusts only this control-plane value, never client input.
  sandboxHost: text("sandbox_host"),
  // Held by whichever request is currently waking this user. Two concurrent
  // wakes could create two homes or fork one.
  wakeClaimAt: timestamp("wake_claim_at", { withTimezone: true }),
  // Why the last wake could not bring the home up. Cleared by the next
  // successful wake. Lets requests that waited on that wake report the reason,
  // and stops every request from retrying a home that just failed.
  wakeFailure: jsonb("wake_failure").$type<SandboxFailure>(),
  wakeFailureAt: timestamp("wake_failure_at", { withTimezone: true }),
  // Unused: experiment emails are gone. Kept so no migration drops the column.
  notificationEmail: text("notification_email"),
  trialSpentMicros: integer("trial_spent_micros").default(0).notNull(),
  consentVersion: integer("consent_version"),
  voiceOpenAiAccepted: boolean("voice_openai_accepted").default(false).notNull(),
  experimentsTogetherAccepted: boolean("experiments_together_accepted").default(false).notNull(),
  consentAcceptedAt: timestamp("consent_accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const credentialBindings = pgTable(
  "credential_bindings",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    envName: text("env_name").notNull(),
    upstreamOrigin: text("upstream_origin").notNull(),
    allowedPathPrefix: text("allowed_path_prefix").default("/").notNull(),
    authHeader: text("auth_header").default("Authorization").notNull(),
    authPrefix: text("auth_prefix").default("Bearer ").notNull(),
    baseUrlEnvName: text("base_url_env_name"),
    encryptedValue: jsonb("encrypted_value").$type<Record<string, string>>().notNull(),
    last4: text("last4").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("credential_bindings_user_env").on(t.userId, t.envName),
    index("credential_bindings_user").on(t.userId),
  ],
);

export const credentialEgressWindows = pgTable(
  "credential_egress_windows",
  {
    bindingId: integer("binding_id")
      .notNull()
      .references(() => credentialBindings.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    requestCount: integer("request_count").default(1).notNull(),
    byteCount: integer("byte_count").default(0).notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.bindingId, t.period],
      name: "credential_egress_windows_pk",
    }),
    index("credential_egress_windows_start").on(t.windowStart),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    model: text("model").notNull(),
    usage: jsonb("usage").notNull(),
    costMicros: integer("cost_micros").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("usage_events_user_source_external").on(t.userId, t.source, t.externalId),
    index("usage_events_created_at").on(t.createdAt),
  ],
);

// Idempotency for sandbox → platform finish callbacks. Keyed by user rather
// than by sandbox: a sandbox id only lives for one wake, so keying on it would
// re-send an email for the same experiment after every sleep.
export const sessionNotifications = pgTable(
  "session_notifications",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    projectKey: text("project_key").notNull(),
    sessionId: integer("session_id").notNull(),
    status: text("status").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("session_notifications_user_project_session").on(
      t.userId,
      t.projectKey,
      t.sessionId,
    ),
  ],
);

// Voice conversation memory, one row per user. Lives here (not in the sandbox)
// so it survives sandbox re-provisioning. The raw transcript is written during
// the session; the summary is distilled lazily on the next read.
export const voiceMemories = pgTable("voice_memories", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id),
  summary: text("summary").default("").notNull(),
  transcript: text("transcript").default("").notNull(),
  uiLocation: text("ui_location").default("").notNull(),
  transcriptAt: timestamp("transcript_at", { withTimezone: true }),
  summarizedAt: timestamp("summarized_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tryUsage = pgTable("try_usage", {
  day: date("day", { mode: "string" }).primaryKey(),
  voiceSeconds: integer("voice_seconds").default(0).notNull(),
  answers: integer("answers").default(0).notNull(),
});

export const trySpend = pgTable("try_spend", {
  key: text("key").primaryKey(),
  spentMicros: integer("spent_micros").default(0).notNull(),
});

export const tryVoiceCalls = pgTable(
  "try_voice_calls",
  {
    callId: text("call_id").primaryKey(),
    day: date("day", { mode: "string" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    personKey: text("person_key"),
    ipKey: text("ip_key"),
    paidSeconds: integer("paid_seconds"),
  },
  (t) => [index("try_voice_calls_open").on(t.startedAt).where(sql`${t.endedAt} is null`)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type SessionNotification = typeof sessionNotifications.$inferSelect;
export type VoiceMemoryRow = typeof voiceMemories.$inferSelect;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type CredentialBinding = typeof credentialBindings.$inferSelect;
export type CredentialEgressWindow = typeof credentialEgressWindows.$inferSelect;
