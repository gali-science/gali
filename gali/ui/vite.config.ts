import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function parseEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) out[match[1]!] = match[2]!;
    }
    return out;
  } catch {
    return {};
  }
}

function mergeEnv(mode: string) {
  const root = resolve(import.meta.dirname, "../..");
  for (const dir of [root, import.meta.dirname]) {
    for (const [key, value] of Object.entries(loadEnv(mode, dir, ""))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<unknown>) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
      throw new TypeError("request body contained a non-byte chunk");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

function isServerResponse(value: unknown): value is ServerResponse<IncomingMessage> {
  return typeof value === "object"
    && value !== null
    && "writeHead" in value
    && typeof value.writeHead === "function"
    && "end" in value
    && typeof value.end === "function";
}

function vercelish(res: ServerResponse) {
  const api = {
    statusCode: 200,
    headersSent: false,
    status(code: number) {
      api.statusCode = code;
      return api;
    },
    setHeader(key: string, value: string) {
      res.setHeader(key, value);
      return api;
    },
    json(body: unknown) {
      res.statusCode = api.statusCode;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
      api.headersSent = true;
      return api;
    },
  };
  return api;
}

// Dev-only: serve control-plane routes from api/* under Vite. `any` avoids
// VercelRequest vs unknown fights under `tsc -b` (this file is in tsconfig).
type LocalApiHandler = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- local Vite shim
  default: (req: any, res: any) => void | Promise<void>;
};

function localControlPlaneApi(): Plugin {
  return {
    name: "gali-local-control-plane-api",
    configureServer(server) {
      const mount = (
        path: string,
        load: () => Promise<LocalApiHandler>,
        query: Record<string, string> = {},
      ) => {
        server.middlewares.use(path, (req, res, next) => {
          void (async () => {
            try {
              const body =
                req.method === "GET" || req.method === "HEAD"
                  ? undefined
                  : await readJsonBody(req);
              const { default: handler } = await load();
              await handler(
                {
                  method: req.method,
                  headers: req.headers,
                  body,
                  query,
                },
                vercelish(res),
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: message }));
              }
            }
          })().catch(next);
        });
      };

      // .js specifier (not .ts): tsc forbids .ts extensions here; Vite resolves to source.
      mount("/api/me", () => import("./api/account.js") as Promise<LocalApiHandler>, {
        op: "me",
      });
      mount("/api/health", () => import("./api/account.js") as Promise<LocalApiHandler>, {
        op: "health",
      });
      mount("/api/memory", () => import("./api/account.js") as Promise<LocalApiHandler>, {
        op: "memory",
      });
      mount("/api/usage", () => import("./api/account.js") as Promise<LocalApiHandler>, {
        op: "usage",
      });
      mount("/api/consent", () => import("./api/account.js") as Promise<LocalApiHandler>, {
        op: "consent",
      });
      mount("/api/client-error", () => import("./api/account.js") as Promise<LocalApiHandler>, {
        op: "client-error",
      });
      mount("/api/client-event", () => import("./api/account.js") as Promise<LocalApiHandler>, {
        op: "client-event",
      });
      mount("/api/try/session", () => import("./api/try.js") as Promise<LocalApiHandler>, {
        op: "session",
      });
      mount("/api/try/answer", () => import("./api/try.js") as Promise<LocalApiHandler>, {
        op: "answer",
      });
      mount("/api/try/extend", () => import("./api/try.js") as Promise<LocalApiHandler>, {
        op: "extend",
      });
      mount("/api/try/end", () => import("./api/try.js") as Promise<LocalApiHandler>, {
        op: "end",
      });
      mount("/api/try/title", () => import("./api/try.js") as Promise<LocalApiHandler>, {
        op: "title",
      });
      server.middlewares.use("/api/model", (req, res, next) => {
        void (async () => {
          const { default: handler } = await (import("./api/model-gateway.js") as Promise<LocalApiHandler>);
          const gatewayPath = (req.url ?? "").split("?")[0]!.replace(/^\/+/, "");
          const response = Object.assign(res, {
            status(code: number) {
              res.statusCode = code;
              return response;
            },
            json(body: unknown) {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(body));
              return response;
            },
          });
          await handler(Object.assign(req, { query: { gatewayPath } }), response);
        })().catch(next);
      });
    },
  };
}

function localSandboxEnsure(): Plugin {
  return {
    name: "gali-local-sandbox-ensure",
    configureServer(server) {
      server.middlewares.use("/api/sandbox/ensure", (req, res, next) => {
        if (req.method !== "POST" && req.method !== "GET") {
          next();
          return;
        }
        void (async () => {
          const { getSession } = await import("./api/_lib/auth.js");
          const session = await getSession({
            method: req.method,
            headers: req.headers,
            url: req.url,
          });
          res.setHeader("Content-Type", "application/json");
          if (!session) {
            res.statusCode = 401;
            res.end(JSON.stringify({ error: "authentication required" }));
            return;
          }
          res.end(JSON.stringify({ status: "ready", mode: "shared", local: true }));
        })().catch(next);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  mergeEnv(mode);
  const env = loadEnv(mode, import.meta.dirname, "");
  // .env.local can be rewritten while Vite runs; loadEnv lets stale process.env
  // values win on config reload, so read the file directly.
  const fileEnv = parseEnvFile(resolve(import.meta.dirname, ".env.local"));
  const target = (fileEnv.VITE_GALI_HTTP_URL ?? env.VITE_GALI_HTTP_URL)?.replace(/\/$/, "");
  const token = fileEnv.VITE_GALI_HTTP_TOKEN ?? env.VITE_GALI_HTTP_TOKEN;
  const frontendVersion = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || "local";

  return {
    plugins: [react(), localControlPlaneApi(), localSandboxEnsure()],
    define: {
      "import.meta.env.VITE_GALI_VERSION": JSON.stringify(frontendVersion),
    },
    server: {
      port: 5178,
      ...(target
        ? {
            proxy: {
              // Browser stays same-origin; Vite injects the shared secret so the
              // sandbox's public URL is never reached unauthenticated.
              "/api/gali": {
                target,
                changeOrigin: true,
                rewrite: (p) => p.replace(/^\/api\/gali/, ""),
                ...(token
                  ? { headers: { "x-gali-secret": token } }
                  : {}),
                configure: (proxy) => {
                  proxy.on("error", (err, _req, res) => {
                    if (isServerResponse(res) && !res.headersSent) {
                      res.writeHead(502, { "Content-Type": "application/json" });
                      res.end(JSON.stringify({ error: `gali proxy: ${err.message}` }));
                    }
                  });
                },
              },
            },
          }
        : {}),
    },
    base: "./",
  };
});
