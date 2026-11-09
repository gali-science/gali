import type { VercelRequest, VercelResponse } from "@vercel/node";
import { beforeEach, expect, test, vi } from "vitest";
import { GALI_CONFIG } from "../../shared/config.js";
import {
  mintModelGatewayToken,
  mintSandboxCapabilityToken,
} from "./_lib/model-gateway-token.js";

const getUserById = vi.fn();
const recordUsage = vi.fn();

vi.mock("./_lib/users.js", () => ({
  getUserById: (...args: unknown[]) => getUserById(...args),
}));

vi.mock("./_lib/trial.js", () => ({
  trialStatus: (user: { trialSpentMicros: number }) => ({
    status: user.trialSpentMicros >= 10_000_000 ? "exhausted" : "active",
    spentUsd: user.trialSpentMicros / 1_000_000,
    budgetUsd: 10,
    remainingUsd: Math.max(0, 10 - user.trialSpentMicros / 1_000_000),
  }),
  recordUsageWithRetry: (...args: unknown[]) => recordUsage(...args),
}));

function request(
  token: string,
  path = "v1/responses",
  body: unknown = { model: "moonshotai/Kimi-K3", input: "hello", stream: true },
): VercelRequest {
  return {
    method: "POST",
    query: { gatewayPath: path },
    headers: { authorization: `Bearer ${token}` },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
  } as unknown as VercelRequest;
}

function response(): VercelResponse & {
  statusCode: number;
  output: Buffer[];
  jsonBody?: unknown;
} {
  const res = {
    statusCode: 200,
    output: [] as Buffer[],
    jsonBody: undefined as unknown,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader() {
      return this;
    },
    write(chunk: Buffer) {
      this.headersSent = true;
      this.output.push(chunk);
      return true;
    },
    end() {
      this.headersSent = true;
      return this;
    },
    json(body: unknown) {
      this.headersSent = true;
      this.jsonBody = body;
      return this;
    },
  };
  return res as unknown as ReturnType<typeof response>;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  recordUsage.mockResolvedValue({
    status: "active",
    spentUsd: 0,
    budgetUsd: 10,
    remainingUsd: 10,
  });
  process.env.GALI_MODEL_GATEWAY_SECRET = "gateway-signing-secret";
  process.env.OPENAI_API_KEY = "platform-openai-key";
  process.env.TOGETHER_API_KEY = "platform-together-key";
  process.env.GALI_CODEX_UPSTREAM = "togetherlink";
  getUserById.mockResolvedValue({ id: 7, sandboxId: "box-7", trialSpentMicros: 0 });
});

function togetherUsage() {
  return {
    completedSessions: 1,
    promptTokens: 100,
    cachedTokens: 20,
    completionTokens: 25,
    totalCostUsd: 0.0125,
    models: [{
      model: "zai-org/GLM-5.3",
      promptTokens: 100,
      cachedTokens: 20,
      completionTokens: 25,
      costUsd: 0.0125,
    }],
  };
}

test("forwards an allowed Responses API request and replaces authorization", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response("data: response.output_text.delta\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }))
    .mockResolvedValueOnce(Response.json(togetherUsage()));
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const res = response();

  await handler(request(token), res);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "https://gateway.togetherlink.dev/v1/responses",
  );
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    headers: {
      Authorization: "Bearer platform-together-key",
      "Content-Type": "application/json",
      "x-togetherlink-session-id": expect.any(String),
    },
  });
  const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(Buffer.isBuffer(requestInit.body)).toBe(true);
  const upstreamBody = JSON.parse(
    (requestInit.body as Buffer).toString("utf8"),
  ) as { model: string };
  expect(upstreamBody.model).toBe("moonshotai/Kimi-K3");
  expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/v1/togetherlink/usage?");
  expect(Buffer.concat(res.output).toString()).toContain("response.output_text.delta");
});

test("defaults Codex Responses traffic to OpenAI", async () => {
  delete process.env.GALI_CODEX_UPSTREAM;
  const usage = { input_tokens: 100, output_tokens: 25 };
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_openai", usage },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");

  await handler(
    request(token, "v1/responses", { model: GALI_CONFIG.codexModel, input: "hello", stream: true }),
    response(),
  );

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
  expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
    headers: {
      Authorization: "Bearer platform-openai-key",
      "Content-Type": "application/json",
    },
  });
  expect(recordUsage).toHaveBeenCalledWith({
    userId: 7,
    source: "responses",
    externalId: "resp_openai",
    model: GALI_CONFIG.codexModel,
    usage,
  });
});

test("forwards a non-streaming activity line request to OpenAI and records it", async () => {
  delete process.env.GALI_CODEX_UPSTREAM;
  const usage = { input_tokens: 40, output_tokens: 8 };
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({ id: "resp_activity", usage, output: [] }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const res = response();

  await handler(
    request(token, "v1/responses", { model: GALI_CONFIG.fastModel, input: "hello" }),
    res,
  );

  expect(res.statusCode).toBe(200);
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
  expect(recordUsage).toHaveBeenCalledWith({
    userId: 7,
    source: "responses",
    externalId: "resp_activity",
    model: GALI_CONFIG.fastModel,
    usage,
  });
});

test("rejects a token after its sandbox assignment changes", async () => {
  getUserById.mockResolvedValue({ id: 7, sandboxId: "box-new" });
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const res = response();

  await handler(request(token), res);

  expect(res.statusCode).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("rejects a sleep token at the model gateway", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const token = mintSandboxCapabilityToken("sleep", 7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const res = response();

  await handler(request(token), res);

  expect(res.statusCode).toBe(401);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("rejects unsupported models and endpoints", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const wrongModel = response();
  const wrongPath = response();

  await handler(request(token, "v1/responses", { model: "gpt-unapproved" }), wrongModel);
  await handler(request(token, "v1/files", { model: GALI_CONFIG.codexModel }), wrongPath);

  expect(wrongModel.statusCode).toBe(403);
  expect(wrongPath.statusCode).toBe(404);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("rejects requests whose cost would escape metering", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const background = response();
  const longSecret = response();

  await handler(
    request(token, "v1/responses", { model: "moonshotai/Kimi-K3", input: "hi", background: true }),
    background,
  );
  await handler(
    request(token, "v1/realtime/client_secrets", {
      expires_after: { anchor: "created_at", seconds: 7200 },
      session: { type: "realtime", model: GALI_CONFIG.realtime.model },
    }),
    longSecret,
  );

  expect(background.statusCode).toBe(400);
  expect(longSecret.statusCode).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("rejects the OpenAI Codex model while TogetherLink serves Responses", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const res = response();

  await handler(request(token, "v1/responses", { model: GALI_CONFIG.codexModel, input: "hello" }), res);

  expect(res.statusCode).toBe(403);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("passes through a TogetherLink inference failure without requesting usage", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const res = response();

  await handler(request(token), res);

  expect(res.statusCode).toBe(503);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(recordUsage).not.toHaveBeenCalled();
  expect(Buffer.concat(res.output).toString()).toContain("model unavailable");
});

test("uses TogetherLink reported cost without a static model price", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_cost" },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ))
    .mockResolvedValueOnce(Response.json(togetherUsage()));
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const res = response();

  await handler(request(token), res);

  expect(res.statusCode).toBe(200);
  expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
    externalId: "resp_cost",
    model: "moonshotai/Kimi-K3",
    costMicrosOverride: 12_500,
  }));
});

test("forwards the lookup model through TogetherLink and records it", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_lookup" },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ))
    .mockResolvedValueOnce(Response.json(togetherUsage()));
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const res = response();

  await handler(
    request(token, "v1/responses", {
      model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
      input: "hello",
      stream: true,
    }),
    res,
  );

  expect(res.statusCode).toBe(200);
  const upstreamBody = JSON.parse(
    ((fetchMock.mock.calls[0]?.[1] as RequestInit).body as Buffer).toString("utf8"),
  ) as { model: string };
  expect(upstreamBody.model).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017");
  expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
    externalId: "resp_lookup",
    model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  }));
});

test("does not record malformed TogetherLink usage", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { id: "resp_bad_usage" },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ))
    .mockResolvedValueOnce(Response.json({ ...togetherUsage(), totalCostUsd: "bad" }));
  vi.stubGlobal("fetch", fetchMock);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");

  await handler(request(token), response());

  expect(recordUsage).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual(expect.objectContaining({
    eventName: "control.request.failed",
    errorMessage: expect.stringMatching(/totalCostUsd is invalid/),
  }));
  error.mockRestore();
});

test("rejects Responses but keeps hosted voice available after the trial is spent", async () => {
  getUserById.mockResolvedValue({
    id: 7,
    sandboxId: "box-7",
    trialSpentMicros: 10_000_000,
  });
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({ client_secret: { value: "ephemeral" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const responses = response();
  const realtime = response();

  await handler(request(token), responses);
  await handler(
    request(
      token,
      "v1/realtime/client_secrets",
      { session: { model: "gpt-realtime-2.1" } },
    ),
    realtime,
  );

  expect(responses.statusCode).toBe(402);
  expect(realtime.statusCode).toBe(200);
  expect(responses.jsonBody).toMatchObject({
    error: { code: "trial_exhausted" },
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "https://api.openai.com/v1/realtime/client_secrets",
  );
});

test("keeps voice available when the configured realtime model has no price", async () => {
  vi.doMock("../../shared/config.js", () => ({
    GALI_CONFIG: { ...GALI_CONFIG, realtime: { ...GALI_CONFIG.realtime, model: "gpt-realtime-9" } },
  }));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({ client_secret: { value: "ephemeral" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const token = mintModelGatewayToken(7, "box-7");
  const { default: handler } = await import("./model-gateway.js");
  const realtime = response();

  await handler(
    request(token, "v1/realtime/client_secrets", { session: { model: "gpt-realtime-9" } }),
    realtime,
  );

  expect(realtime.statusCode).toBe(200);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledWith("[gali] missing model price: gpt-realtime-9.input");
  error.mockRestore();
  vi.doUnmock("../../shared/config.js");
});

test.each(["response.completed", "response.failed"])(
  "records usage from a terminal Responses stream event: %s",
  async (type: string) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        `data: ${JSON.stringify({
          type,
          response: { id: "resp_1" },
        })}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ))
      .mockResolvedValueOnce(Response.json(togetherUsage()));
    vi.stubGlobal("fetch", fetchMock);
    const token = mintModelGatewayToken(7, "box-7");
    const { default: handler } = await import("./model-gateway.js");

    await handler(request(token), response());

    expect(recordUsage).toHaveBeenCalledWith({
      userId: 7,
      source: "responses",
      externalId: "resp_1",
      model: "moonshotai/Kimi-K3",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 25,
        models: togetherUsage().models,
      },
      costMicrosOverride: 12_500,
    });
  },
);
