import fs from "node:fs";
import path from "node:path";

// Loads gali/.env, falling back to the workspace-root .env for local dev.
// Does not validate specific keys — consumers fail-fast when a key they need is missing.
export function loadEnv(): string | null {
  for (const rel of [".env", "../.env"]) {
    const abs = path.resolve(process.cwd(), rel);
    if (fs.existsSync(abs)) {
      process.loadEnvFile(abs);
      return abs;
    }
  }
  return null;
}
