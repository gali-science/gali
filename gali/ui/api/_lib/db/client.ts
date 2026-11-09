import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is not set`);
  return value.trim();
}

// Module-scoped: Vercel reuses this module across invocations on a warm instance,
// so one connection is held open rather than opened per request. max: 1 keeps each
// function instance to a single connection — with many concurrent instances this
// still adds up, but is the standard shape for serverless + Postgres.
let sql: ReturnType<typeof postgres> | null = null;

export function db() {
  if (!sql) sql = postgres(requireEnv("DATABASE_URL"), { max: 1 });
  return drizzle(sql, { schema });
}
