import path from "node:path";

export function loadOpsEnv(): void {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../.env"));
}

// `vercel env pull` writes the project's OIDC token here; it scopes the
// Sandbox SDK to the linked project.
export function loadVercelEnv(): void {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../gali/ui/.env.local"));
}
