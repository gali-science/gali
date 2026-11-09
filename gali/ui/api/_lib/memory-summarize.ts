import { checkModelPrice } from "./pricing.js";
import {
  MEMORY_OUTPUT_CONTRACT,
  MEMORY_SUMMARY_INSTRUCTIONS,
  renderMemoryInput,
} from "./memory-prompt.js";

type ResponsesOutput = {
  id?: string;
  usage?: Record<string, unknown>;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};
const MEMORY_MODEL = "gpt-6-luna";

export async function summarizeTranscript(input: {
  transcript: string;
  previousSummary: string;
}): Promise<{
  summary: string;
  model: string;
  responseId?: string;
  usage?: Record<string, unknown>;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey?.trim()) throw new Error("OPENAI_API_KEY is not set on Vercel");
  const model = MEMORY_MODEL;
  checkModelPrice(model, "memory");
  const prompt = renderMemoryInput(input);
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: MEMORY_SUMMARY_INSTRUCTIONS,
      input: prompt,
      max_output_tokens: MEMORY_OUTPUT_CONTRACT.maxOutputTokens,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`memory summarize -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as ResponsesOutput;
  let text = "";
  for (const item of data.output ?? []) {
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  const summary = text.trim();
  if (!summary) throw new Error("memory summarize returned no text");
  return {
    summary,
    model,
    ...(typeof data.id === "string" ? { responseId: data.id } : {}),
    ...(data.usage ? { usage: data.usage } : {}),
  };
}
