import path from "node:path";

export const GALI_ROOT = path.resolve(import.meta.dirname, "../gali");

export const BASE_IMAGE = "node:22-bookworm-slim";
/** Paths under gali/ that make up /app. Everything else stays on the dev machine. */
export const GALI_SOURCE = [
  "src",
  "shared",
  "drizzle",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "drizzle.config.ts",
];

/** Provisioning steps for the base image, in order. Keep them idempotent. */
export const BUILD_STEPS: { label: string; script: string }[] = [
  {
    // Statics live in profile.d, so every `bash -lc` exec sees them. Without
    // the corepack setting, pnpm stops to ask before downloading itself.
    label: "static env",
    script:
      "printf '%s\\n' " +
      "'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0' " +
      "'export ELECTRON_SKIP_BINARY_DOWNLOAD=1' " +
      "'export GALI_DATA=/gali-data' " +
      "'export CODEX_HOME=/root/.codex' " +
      "> /etc/profile.d/gali.sh && chmod 644 /etc/profile.d/gali.sh",
  },
  {
    label: "apt packages",
    script:
      "apt-get update && apt-get install -y --no-install-recommends " +
      "ca-certificates curl git procps python3 python3-venv && rm -rf /var/lib/apt/lists/*",
  },
  {
    // UV_INSTALL_DIR keeps uv on the global PATH; its default ~/.local/bin is
    // not on PATH for the non-login shells Leo spawns.
    label: "uv",
    script: "curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh",
  },
  {
    // Gali runs the @openai/codex pinned in package.json from node_modules.
    label: "pnpm deps",
    script: "corepack enable && cd /app && pnpm install --frozen-lockfile",
  },
];
