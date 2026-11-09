import { defineConfig } from "drizzle-kit";

// Control-plane schema (users + sandbox assignment), entirely separate from
// gali/drizzle.config.ts, which migrates the per-sandbox Gali database.
export default defineConfig({
  dialect: "postgresql",
  schema: "./api/_lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://gali:gali@localhost:5432/gali_control",
  },
});
