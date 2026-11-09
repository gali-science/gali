import { GALI_CONFIG } from "../../../shared/config.js";
import { resolveOpenAiTransport } from "./transport.js";

type ResponsesBody = {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string | null }> | null;
  }>;
};

/** One low-effort Responses call on the fast model; returns its text, trimmed. */
export async function fastModelText(input: {
  label: string;
  instructions: string;
  input: string;
  maxOutputTokens: number;
  timeoutMs: number;
}): Promise<string> {
  const transport = resolveOpenAiTransport();
  const response = await fetch(`${transport.baseUrl}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${transport.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.GALI_FAST_MODEL?.trim() || GALI_CONFIG.fastModel,
      instructions: input.instructions,
      input: input.input,
      max_output_tokens: input.maxOutputTokens,
      reasoning: { effort: "low" },
    }),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${input.label} request failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as ResponsesBody;
  let text = "";
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") text += part.text;
    }
  }
  const answer = text.trim();
  if (!answer) throw new Error(`${input.label} response contained no text`);
  return answer;
}
