import { GALI_CONFIG } from "../../../shared/config.js";
import { VOICE_INSTRUCTIONS } from "../../voice/prompt.js";
import { voiceToolSchemas } from "../../voice/tools/schemas.js";
import { resolveOpenAiTransport } from "./transport.js";

export type RealtimeTurnDetection = {
  type: "semantic_vad";
  eagerness: string;
  create_response: boolean;
  interrupt_response: boolean;
};

export type MintedToken = {
  client_secret: { value: string };
  model: string;
  turn_detection: RealtimeTurnDetection;
  metered: boolean;
};

export class RealtimeTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

function buildTurnDetection(createResponse = true): RealtimeTurnDetection {
  return {
    type: "semantic_vad",
    eagerness: GALI_CONFIG.realtime.vadEagerness,
    create_response: createResponse,
    interrupt_response: true,
  };
}

export async function mintRealtimeToken(): Promise<MintedToken> {
  const transport = resolveOpenAiTransport();
  const { model } = GALI_CONFIG.realtime;
  const turnDetection = buildTurnDetection(true);
  const response = await fetch(`${transport.baseUrl}/realtime/client_secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${transport.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model,
        instructions: VOICE_INSTRUCTIONS,
        reasoning: { effort: GALI_CONFIG.realtime.reasoningEffort },
        output_modalities: ["audio"],
        audio: {
          input: {
            transcription: {
              model: GALI_CONFIG.realtime.transcribeModel,
            },
            noise_reduction: {
              type: GALI_CONFIG.realtime.noiseReduction,
            },
            turn_detection: turnDetection,
          },
          output: { voice: GALI_CONFIG.realtime.voice },
        },
        tools: voiceToolSchemas(),
        tool_choice: "auto",
      },
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    let code: string | undefined;
    let message = text;
    try {
      const body = JSON.parse(text) as {
        error?: string | { code?: unknown; message?: unknown };
        code?: unknown;
      };
      if (typeof body.error === "object" && body.error !== null) {
        if (typeof body.error.code === "string") code = body.error.code;
        if (typeof body.error.message === "string") message = body.error.message;
      } else if (typeof body.error === "string") {
        message = body.error;
      }
      if (!code && typeof body.code === "string") code = body.code;
    } catch {
    }
    throw new RealtimeTokenError(
      response.status,
      code,
      message || `client_secrets failed (${response.status})`,
    );
  }
  const data = (await response.json()) as {
    value?: string;
    client_secret?: string | { value?: string; client_secret?: { value?: string } };
  };
  const nested = data.client_secret;
  const value = data.value ??
    (typeof nested === "string" ? nested : nested?.value ?? nested?.client_secret?.value);
  if (!value) throw new Error("Realtime token response contained no client secret");
  return {
    client_secret: { value },
    model,
    turn_detection: turnDetection,
    metered: transport.source === "gateway",
  };
}
