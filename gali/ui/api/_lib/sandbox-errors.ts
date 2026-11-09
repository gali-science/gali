import type { VercelResponse } from "@vercel/node";
import type { SandboxErrorBody } from "../../../shared/sandbox-health.js";
import { SandboxBusyError, SandboxUnavailableError } from "./sandbox-provider/types.js";

const BUSY_RETRY_AFTER_SECONDS = 5;

type SandboxErrorReply = { status: 503; body: SandboxErrorBody; retryAfterSeconds: number | null };

/** The typed reply for an error that means "the sandbox cannot serve this user", else null. */
export function sandboxErrorReply(error: unknown, requestId: string): SandboxErrorReply | null {
  if (error instanceof SandboxUnavailableError) {
    return {
      status: 503,
      body: { error: "sandbox_unavailable", failure: error.failure, requestId },
      retryAfterSeconds: null,
    };
  }
  if (error instanceof SandboxBusyError) {
    return {
      status: 503,
      body: { error: "sandbox_waking", requestId },
      retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS,
    };
  }
  return null;
}

export function sendSandboxErrorReply(res: VercelResponse, reply: SandboxErrorReply): void {
  if (reply.retryAfterSeconds !== null) res.setHeader("retry-after", String(reply.retryAfterSeconds));
  res.status(reply.status).json(reply.body);
}
