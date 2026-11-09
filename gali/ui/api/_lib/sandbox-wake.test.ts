import { afterEach, expect, test } from "vitest";
import {
  verifyModelGatewayToken,
  verifySandboxCapabilityToken,
} from "./model-gateway-token.js";
import { sandboxHttpSecret } from "./sandbox-http-auth.js";
import {
  CLEAR_CODEX_AUTH_SCRIPT,
  REMOVE_SPAWN_GUARD_SCRIPT,
  SERVER_SCRIPT,
  STOP_SERVER_SCRIPT,
  serverEnv,
} from "./sandbox-wake.js";

afterEach(() => {
  delete process.env.GALI_MODEL_GATEWAY_SECRET;
  delete process.env.GALI_SANDBOX_HTTP_MASTER_KEY;
  delete process.env.GALI_MODEL_GATEWAY_URL;
  delete process.env.GALI_CODEX_UPSTREAM;
  delete process.env.GALI_SLEEP_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_AUTH_JSON;
});

test("the wake script appends logs and does not replace the serve-loop", () => {
  expect(SERVER_SCRIPT).toContain(">>/tmp/gali-http.log");
  expect(SERVER_SCRIPT).toContain("scripts/serve-loop.ts");
  expect(STOP_SERVER_SCRIPT).not.toContain("pkill");
  expect(STOP_SERVER_SCRIPT).toContain("/proc/[0-9]*/cmdline");
  expect(STOP_SERVER_SCRIPT).toContain("rm -rf /tmp/gali-serve.lock");
});

test("sandbox receives only a signed gateway credential", () => {
  process.env.GALI_MODEL_GATEWAY_SECRET = "signing-secret";
  process.env.GALI_SANDBOX_HTTP_MASTER_KEY = "http-master-key";
  process.env.GALI_MODEL_GATEWAY_URL = "https://gali.example/api/model/v1/";
  process.env.GALI_SLEEP_URL = "https://gali.example/api/sandbox?op=sleep";
  process.env.OPENAI_API_KEY = "platform-openai-key";
  process.env.CODEX_AUTH_JSON = '{"platform":"codex"}';

  const env = serverEnv(7, "box-7");
  expect(env.GALI_MODEL_GATEWAY_URL).toBe("https://gali.example/api/model/v1");
  expect(env.GALI_CODEX_MODEL).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.CODEX_AUTH_JSON).toBeUndefined();
  expect(verifyModelGatewayToken(env.GALI_MODEL_GATEWAY_TOKEN!)).toMatchObject({
    userId: 7,
    sandboxId: "box-7",
  });
  expect(env.GALI_CREDENTIAL_GATEWAY_TOKEN).toBeUndefined();
  expect(env.GALI_HTTP_SECRET).toBe(sandboxHttpSecret(7, "box-7"));
  expect(env.GALI_HTTP_SECRET).not.toBe(process.env.GALI_SANDBOX_HTTP_MASTER_KEY);
  expect(verifySandboxCapabilityToken(env.GALI_SLEEP_TOKEN!, "sleep")).toMatchObject({
    userId: 7,
    sandboxId: "box-7",
  });
  expect(env.GALI_NOTIFY_TOKEN).toBeUndefined();
});

test("sandbox gets the TogetherLink Codex model only when TogetherLink serves Responses", () => {
  process.env.GALI_MODEL_GATEWAY_SECRET = "signing-secret";
  process.env.GALI_SANDBOX_HTTP_MASTER_KEY = "http-master-key";
  process.env.GALI_MODEL_GATEWAY_URL = "https://gali.example/api/model/v1";

  expect(serverEnv(7, "box-7").GALI_GATEWAY_CODEX_MODEL).toBeUndefined();
  expect(serverEnv(7, "box-7").GALI_FAST_MODEL).toBeUndefined();

  process.env.GALI_CODEX_UPSTREAM = "togetherlink";
  const env = serverEnv(7, "box-7");
  expect(env.GALI_GATEWAY_CODEX_MODEL).toBe("moonshotai/Kimi-K3");
  expect(env.GALI_FAST_MODEL).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017");
});

test("wake removes reusable Codex credentials from durable paths", () => {
  expect(CLEAR_CODEX_AUTH_SCRIPT).toContain("/root/.codex/auth.json");
  expect(CLEAR_CODEX_AUTH_SCRIPT).toContain("/gali-data/codex/auth.json");
  expect(CLEAR_CODEX_AUTH_SCRIPT).toContain("/gali-data/codex-homes/*/auth.json");
});

test("wake removes the old Codex hook that blocks the reviewer's subagent", () => {
  expect(REMOVE_SPAWN_GUARD_SCRIPT).toContain("/etc/codex/requirements.toml");
});
