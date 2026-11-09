// End-to-end proof of the provider's lifecycle with the real Gali server:
// create a home from the image running the local source, drive Gali over the
// public URL (including SSE), check what the agent user can reach and fill,
// sleep it, wake it again, confirm the work survived, and destroy the home.
// Touches no real user. GALI_SANDBOX_IMAGE names the image to prove.
//
//   tsx prove-cycle.ts vercel

import { randomBytes } from "node:crypto";
import { APIError, Drive } from "@vercel/sandbox";
import { sandboxHttpHeaders } from "../gali/ui/api/_lib/sandbox-http-auth.js";
import {
  SANDBOX_PROVIDERS,
  sandboxProvider,
  SandboxCommandError,
  type LiveSandbox,
  type SandboxProviderKind,
} from "../gali/ui/api/_lib/sandbox-provider/index.js";
import { ensureServer, type ReadySandbox } from "../gali/ui/api/_lib/sandbox-wake.js";
import { uploadGaliSource } from "./source.js";
import { loadOpsEnv, loadVercelEnv } from "./env.js";

loadOpsEnv();
loadVercelEnv();
// The proof is the only client of its throwaway sandbox, so it never needs the platform's key.
process.env.GALI_SANDBOX_HTTP_MASTER_KEY = randomBytes(32).toString("hex");

const kind = process.argv[2];
if (!SANDBOX_PROVIDERS.includes(kind as SandboxProviderKind)) {
  throw new Error(`usage: prove-cycle.ts <${SANDBOX_PROVIDERS.join("|")}>`);
}
const provider = sandboxProvider(kind as SandboxProviderKind);
const OWNER = `gali-prove-cycle-${Date.now()}`;
const PROJECT_KEY = `prove-${Date.now()}`;
const PROOF_USER_ID = 1;
const failures: string[] = [];

function phase(name: string) {
  console.log(`\n=== ${name} ===`);
}

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}

async function api<T>(ready: ReadySandbox, method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ready.host}${route}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...sandboxHttpHeaders(PROOF_USER_ID, ready.id),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

// The upload flow is the only way to create a project; an empty zip is a project started from nothing.
async function createProject(ready: ReadySandbox, title: string, question: string): Promise<{ key: string }> {
  const emptyZip = new Uint8Array(22);
  emptyZip.set([0x50, 0x4b, 0x05, 0x06]);
  const init = await api<{ uploadId: string }>(ready, "POST", "/import-uploads", { title, question });
  const chunk = await fetch(`${ready.host}/import-uploads/${init.uploadId}/chunks/0`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      ...sandboxHttpHeaders(PROOF_USER_ID, ready.id),
    },
    body: emptyZip,
  });
  if (!chunk.ok) throw new Error(`upload chunk -> ${chunk.status}: ${await chunk.text()}`);
  await api(ready, "POST", `/import-uploads/${init.uploadId}/finalize`, { totalChunks: 1, totalBytes: emptyZip.length });
  const deadline = Date.now() + 120_000;
  for (;;) {
    const status = await api<{ state: string; project?: { key: string }; error?: string }>(
      ready,
      "GET",
      `/import-uploads/${init.uploadId}`,
    );
    if (status.state === "done" && status.project) return status.project;
    if (status.state === "error") throw new Error(`import failed: ${status.error ?? "unknown"}`);
    if (Date.now() > deadline) throw new Error("import timed out");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Runs as the user Codex runs as. Exit status and output, never a throw.
async function asAgent(sbx: LiveSandbox, script: string): Promise<{ ok: boolean; output: string }> {
  try {
    const quoted = `'${script.replaceAll("'", "'\\''")}'`;
    return { ok: true, output: await sbx.run(`runuser -u gali-agent -- bash -c ${quoted}`) };
  } catch (error) {
    if (!(error instanceof SandboxCommandError)) throw error;
    return { ok: false, output: error.output };
  }
}

const reach = (url: string) => `curl -sS -o /dev/null -m 8 -w '%{http_code}' ${url}`;

phase(`1. create a ${kind} home from the image, running the local source`);
let started = Date.now();
const created = await provider.wake(null, OWNER);
const home = created.home;
console.log(`  home ${home}, sandbox ${created.sandbox.id}, ${created.boot} boot in ${seconds(started)}`);
let running: string | null = created.sandbox.id;
let projectKey = "";
try {
  const bytes = await uploadGaliSource(created.sandbox);
  console.log(`  uploaded ${(bytes / 1024).toFixed(0)} KB of gali source`);
  started = Date.now();
  const first = await ensureServer(created.sandbox, PROOF_USER_ID, {
    via: "wake",
    boot: "cold",
    awakeForMs: provider.maxAwakeMs,
  });
  console.log(`  healthy in ${seconds(started)} at ${first.host}`);

  phase("2. drive Gali over the public URL");
  const health = await api<{ ok: boolean }>(first, "GET", "/health");
  console.log("  /health:", JSON.stringify(health));
  const project = await createProject(first, `${kind} cycle proof`, "Does state survive a sleep/wake cycle?");
  projectKey = project.key;
  console.log("  created project", project.key);

  phase("2b. ingress: only Gali's port is routed, and it wants the secret");
  const unauthenticated = (await fetch(`${first.host}/health`)).status;
  check("gali without the secret is refused", unauthenticated === 401, String(unauthenticated));
  let strayRouted = true;
  try {
    created.sandbox.url(8080);
  } catch {
    strayRouted = false;
  }
  check("an undeclared port has no public route", !strayRouted);

  phase("2c. egress as the agent user");
  const gatewayHost = new URL(process.env.GALI_MODEL_GATEWAY_URL!).origin;
  for (const [label, url, allowed] of [
    ["model gateway", gatewayHost, true],
    ["pypi", "https://pypi.org/simple/", true],
    ["codeload", "https://codeload.github.com/octocat/Hello-World/tar.gz/HEAD", true],
    ["github.com", "https://github.com", false],
    ["npm registry", "https://registry.npmjs.org/", false],
    ["example.com", "https://example.com", false],
    ["raw IP", "https://1.1.1.1", false],
  ] as const) {
    const result = await asAgent(created.sandbox, reach(url));
    check(`${label} ${allowed ? "reachable" : "blocked"}`, result.ok === allowed, result.output.trim().slice(-120));
  }
  const npmDuringWindow = await created.sandbox.withEgress(["registry.npmjs.org"], () =>
    asAgent(created.sandbox, reach("https://registry.npmjs.org/")));
  check("npm registry reachable inside an egress window", npmDuringWindow.ok, npmDuringWindow.output.trim());
  check("npm registry blocked again after it", !(await asAgent(created.sandbox, reach("https://registry.npmjs.org/"))).ok);

  phase("2d. the agent user's disk is capped");
  const df = await created.sandbox.run("df -B1M --output=target,fstype,size /gali-data /tmp /var/tmp /run/lock");
  console.log(df.trimEnd().replace(/^/gm, "  "));
  check("/tmp is a bounded tmpfs", /\/tmp\s+tmpfs\s+256\b/.test(df));
  check("/run/lock is a bounded tmpfs", /\/run\/lock\s+tmpfs\s+1\b/.test(df));
  const home_ = (await created.sandbox.run("getent passwd gali-agent | cut -d: -f6")).trim();
  check("agent home is under /gali-data", home_ === "/gali-data/agent-home", home_);
  const writable = await asAgent(created.sandbox,
    "find / -xdev \\( -path /proc -o -path /sys -o -path /dev -o -path /tmp -o -path /var/tmp -o -path /run/lock \\) -prune -o -type d -writable -print");
  const writableDirs = writable.output.split("\n").filter((line) => line.startsWith("/"));
  check("agent can write nothing on the uncapped root disk", writableDirs.length === 0, writableDirs.join(" "));
  const fill = await asAgent(created.sandbox,
    "dd if=/dev/zero of=/gali-data/papers/fill bs=1M count=1300 status=none; echo dd=$?; du -sm /gali-data/papers/fill; rm -f /gali-data/papers/fill");
  check("writing past the cap fails", /dd=1/.test(fill.output), fill.output.trim().replace(/\n/g, " "));
  const tmpFill = await asAgent(created.sandbox,
    "dd if=/dev/zero of=/tmp/fill bs=1M count=400 status=none; echo dd=$?; rm -f /tmp/fill");
  check("writing past the /tmp cap fails", /dd=1/.test(tmpFill.output), tmpFill.output.trim().replace(/\n/g, " "));

  phase("3. SSE over the public URL");
  {
    const res = await fetch(`${first.host}/events`, {
      headers: sandboxHttpHeaders(PROOF_USER_ID, first.id),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok || !res.body) throw new Error(`/events -> ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const opened = Date.now();
    let frames = 0;
    while (frames < 1) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value, { stream: true }).split("\n")) {
        if (!line.startsWith("event:")) continue;
        frames += 1;
        console.log(`  +${seconds(opened)} ${line.trim()}`);
      }
    }
    void reader.cancel();
  }

  phase("4. write a file on disk, then sleep");
  await created.sandbox.run(`echo '${PROJECT_KEY}' > /gali-data/prove.txt`);
  started = Date.now();
  await provider.sleep(home, created.sandbox.id);
  running = null;
  console.log(`  slept in ${seconds(started)}`);
  check("attach finds nothing while asleep", (await provider.attach(home)) === null);
  check("the public URL does not wake it", (await fetch(`${first.host}/health`)).status !== 200);
  check("still asleep afterwards", (await provider.attach(home)) === null);

  phase("5. wake again and check the work survived");
  started = Date.now();
  const woken = await provider.wake(home, OWNER);
  running = woken.sandbox.id;
  console.log(`  sandbox ${woken.sandbox.id}, ${woken.boot} boot in ${seconds(started)}`);
  started = Date.now();
  const second = await ensureServer(woken.sandbox, PROOF_USER_ID, {
    via: "wake",
    boot: woken.boot,
    awakeForMs: provider.maxAwakeMs,
  });
  console.log(`  healthy in ${seconds(started)}`);
  // /projects hides projects without a paper unless research mode is on.
  check("project survived",
    (await api<{ key: string } | null>(second, "GET", `/projects/${projectKey}`))?.key === projectKey);
  check("/gali-data/prove.txt survived", (await woken.sandbox.run("cat /gali-data/prove.txt")).trim() === PROJECT_KEY);
  check("same sandbox id and URL after wake", second.id === first.id && second.host === first.host);
  check("/tmp is a tmpfs again after the cold boot",
    /tmpfs/.test(await woken.sandbox.run("df --output=fstype /tmp")));
} finally {
  phase("6. destroy the home");
  await provider.destroy(home, running);
  const driveGone = await Drive.get({ name: home }).then(
    () => false,
    (error: unknown) => error instanceof APIError && error.response.status === 404,
  );
  check("home and its drive are gone", driveGone);
}
if (failures.length) {
  console.log(`\nFAILED: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
