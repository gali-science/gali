export type OpenAiTransport = {
  baseUrl: string;
  apiKey: string;
  source: "gateway" | "environment";
};

// Hosted sandboxes reach OpenAI only through the platform gateway; the desktop app uses its own key.
export function resolveOpenAiTransport(env: NodeJS.ProcessEnv = process.env): OpenAiTransport {
  const gatewayUrl = env.GALI_MODEL_GATEWAY_URL?.trim().replace(/\/$/, "");
  const gatewayToken = env.GALI_MODEL_GATEWAY_TOKEN?.trim();
  if (gatewayUrl || gatewayToken) {
    if (!gatewayUrl || !gatewayToken) {
      throw new Error("GALI_MODEL_GATEWAY_URL and GALI_MODEL_GATEWAY_TOKEN must be set together");
    }
    return { baseUrl: gatewayUrl, apiKey: gatewayToken, source: "gateway" };
  }
  if (env.GALI_SANDBOX_ID?.trim()) {
    throw new Error("hosted sandboxes must use the model gateway");
  }
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("no OpenAI credential is configured");
  return { baseUrl: "https://api.openai.com/v1", apiKey, source: "environment" };
}
