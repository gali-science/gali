// Builds the image every new Vercel home is created from: the base image,
// BUILD_STEPS, and the local gali source at /app, pushed to the linked
// project's Vercel Container Registry. Existing homes keep running the build
// they were made from. Pass the full reference GALI_SANDBOX_IMAGE will name.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APIError, Sandbox } from "@vercel/sandbox";
import { BASE_IMAGE, BUILD_STEPS, GALI_ROOT, GALI_SOURCE } from "./image.js";
import { galiSourceVersion } from "./source.js";
import { loadVercelEnv } from "./env.js";

loadVercelEnv();

const image = process.argv[2];
if (!image) throw new Error("usage: publish-vercel-image vcr.vercel.com/<team>/<project>/<name>:<tag>");
const nameTag = image.split("/").at(-1)!;
if (!/^[\w.-]+:[\w.-]+$/.test(nameTag)) throw new Error(`image needs a name:tag, got ${image}`);
const version = galiSourceVersion();
const linkedDir = path.join(GALI_ROOT, "ui");

const dockerfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gali-image-")), "Dockerfile");
fs.writeFileSync(dockerfile, [
  `FROM --platform=linux/amd64 ${BASE_IMAGE}`,
  "USER root",
  "RUN mkdir -p /app /gali-data /root/.codex",
  "COPY package.json pnpm-lock.yaml /app/",
  ...BUILD_STEPS.map((step) => `# ${step.label}\nRUN ${step.script}`),
  ...GALI_SOURCE.map((entry) => `COPY ${entry} /app/${entry}`),
  `RUN echo '${version}' > /app/.gali-version`,
  "WORKDIR /app",
  "",
].join("\n"));

const started = Date.now();
execFileSync("vercel", ["vcr", "login", "docker"], { cwd: linkedDir, stdio: "inherit" });
execFileSync("vercel", ["vcr", "build", "docker", GALI_ROOT, nameTag, "--push", "--", "-f", dockerfile], {
  cwd: linkedDir,
  stdio: "inherit",
});
console.log(`pushed ${image} in ${((Date.now() - started) / 1000).toFixed(0)}s`);

// A freshly pushed image takes a moment before sandboxes can boot from it.
async function createCheck(): Promise<Sandbox> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await Sandbox.create({ image, timeout: 600_000, tags: { app: "gali", role: "image-check" } });
    } catch (error) {
      const notReady = error instanceof APIError && JSON.stringify(error.json ?? "").includes("image_not_ready");
      if (!notReady || attempt === 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

const check = await createCheck();
try {
  const proof = await check.runCommand({
    cmd: "bash",
    args: ["-lc",
      "test \"$(id -u)\" = 0" +
      " && test -d /app/node_modules && test -f /app/scripts/serve-loop.ts" +
      " && test ! -e /root/.codex/auth.json && test ! -e /app/.env" +
      ` && test "$(cat /app/.gali-version)" = '${version}'` +
      " && test \"$GALI_DATA\" = /gali-data && test \"$CODEX_HOME\" = /root/.codex" +
      " && command -v ps mountpoint useradd" +
      " && /app/node_modules/.bin/codex --version && pnpm --version && uv --version"],
  });
  const output = await proof.output("both");
  if (proof.exitCode !== 0) throw new Error(`image check failed (exit ${proof.exitCode}):\n${output}`);
  console.log(output.trim());
  console.log(`verified ${image} at ${version}; set GALI_SANDBOX_IMAGE=${image}`);
} finally {
  await check.stop();
  await check.delete({ deleteOrphanSnapshots: true });
}
