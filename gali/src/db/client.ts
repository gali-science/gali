import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.js";

export type Db = PgliteDatabase<typeof schema>;

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

export type GaliDb = { db: Db; client: PGlite };

// A crashed PGlite leaves this behind; the next open then WASM-aborts.
export function clearStalePostmasterPid(dbDir: string): void {
  if (dbDir.startsWith("memory:")) return;
  try {
    fs.unlinkSync(path.join(dbDir, "postmaster.pid"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// `dbDir` = "memory://" for tests, or an on-disk path for the app.
export async function createDb(dbDir: string, migrations = migrationsFolder): Promise<GaliDb> {
  clearStalePostmasterPid(dbDir);
  const client = await PGlite.create(dbDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrations });
  return { db, client };
}
