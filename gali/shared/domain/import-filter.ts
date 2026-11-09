// Single source of truth for what an upload excludes and what the file tree
// hides. The sandbox applies it during extraction; the reviewer's scratch
// folder (.review) never shows up in the tree.

export const IMPORT_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git", ".gali", ".review", ".venv", "venv", "__pycache__", "node_modules", "build", "dist",
  "out", "target", ".cache", "cache", ".next", ".nuxt", "coverage", "__macosx",
]);

export const IMPORT_SKIPPED_FILES: ReadonlySet<string> = new Set([".ds_store"]);

const SENSITIVE_DIRECTORIES = new Set([
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".ssh",
  "credential",
  "credentials",
  "secret",
  "secrets",
]);

const SENSITIVE_FILES = new Set([
  ".env",
  ".envrc",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials",
  "credentials.json",
  "secrets",
  "secrets.json",
  "token.json",
]);

const SENSITIVE_STEMS = new Set([
  "accesstoken",
  "apikey",
  "apikeys",
  "clientsecret",
  "credential",
  "credentials",
  "privatekey",
  "refreshtoken",
  "secret",
  "secrets",
  "serviceaccount",
  "token",
  "tokens",
]);

export function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((part) => SENSITIVE_DIRECTORIES.has(part))) return true;
  const name = parts.at(-1)!;
  const stem = name.replace(/\.[^.]+$/, "");
  const compactStem = stem.replace(/[._-]/g, "");
  if (SENSITIVE_FILES.has(name) || SENSITIVE_STEMS.has(compactStem)) return true;
  if (name.startsWith(".env.") || name.endsWith(".env")) return true;
  if (/(^|[._-])(credential|credentials|secret|secrets)$/.test(stem)) return true;
  if (/^(credentials?|secrets?)(\.[a-z0-9_-]+)+$/.test(name)) return true;
  if (/^(api[._-]?key|access[._-]?token|refresh[._-]?token)(\.[a-z0-9_-]+)*$/.test(name)) return true;
  if (/(^|[._-])private[._-]?key([._-]|$)/.test(name)) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(name)) return true;
  return /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/.test(name);
}

// A path is excluded when any directory segment is a skipped directory, or
// the sensitive-path rules flag it.
export function isExcludedImportPath(relativePath: string): boolean {
  const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some((part) => IMPORT_SKIPPED_DIRECTORIES.has(part.toLowerCase()))) return true;
  if (IMPORT_SKIPPED_FILES.has(parts.at(-1)!.toLowerCase())) return true;
  return isSensitivePath(relativePath);
}
