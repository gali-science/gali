import { afterEach, expect, test, vi } from "vitest";
import { ensureSandboxReady } from "./http-bridge";
import { createWorkspaceHealthMonitor } from "./workspace-health";

function ndjson(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
}

function stubEnsure(response: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input).includes("/api/sandbox/ensure") ? response() : new Response(null, { status: 202 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("streamed wake phases reach the boot screen before ready", async () => {
  const fetchMock = stubEnsure(() => ndjson([
    '{"type":"progress","phase":"waking"}\n{"type":"progress","ph',
    'ase":"updating"}\n',
    '{"type":"progress","phase":"starting"}\n{"type":"ready","sandboxId":"sbx-1"}\n',
  ]));
  const phases: string[] = [];
  const result = await ensureSandboxReady(createWorkspaceHealthMonitor(), (phase) => phases.push(phase));
  expect(result).toEqual({ status: "ready" });
  expect(phases).toEqual(["waking", "updating", "starting"]);
  const [, init] = fetchMock.mock.calls.find(([input]) => String(input).includes("/api/sandbox/ensure"))!;
  expect(new Headers(init?.headers).get("Accept")).toContain("application/x-ndjson");
});

test("a failure line is handled like the old 503 body", async () => {
  stubEnsure(() => ndjson([
    '{"type":"progress","phase":"updating"}\n',
    '{"type":"failed","status":503,"body":{"error":"sandbox_unavailable","requestId":"req-1",'
      + '"failure":{"kind":"server_failed","provider":"vercel","detail":"install exited 1"}}}\n',
  ]));
  await expect(ensureSandboxReady(createWorkspaceHealthMonitor())).rejects.toMatchObject({
    name: "WorkspaceUnavailableError",
  });
});

test("a plain JSON ready still works (local dev and old servers)", async () => {
  stubEnsure(() => new Response(JSON.stringify({ status: "ready" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  await expect(ensureSandboxReady(createWorkspaceHealthMonitor())).resolves.toEqual({ status: "ready" });
});
