export type RealtimeTurnDetection = {
  type: "semantic_vad";
  eagerness: string;
  create_response: boolean;
  interrupt_response: boolean;
};

export function ephemeralKeyFromToken(tokenData: {
  client_secret?: unknown;
  value?: string;
}): string | undefined {
  const secret = tokenData.client_secret;
  if (typeof secret === "string") return secret;
  if (secret !== null && typeof secret === "object") {
    const record = secret as { value?: unknown; client_secret?: unknown };
    if (typeof record.value === "string") return record.value;
    if (record.client_secret !== null && typeof record.client_secret === "object") {
      const nested = record.client_secret as { value?: unknown };
      if (typeof nested.value === "string") return nested.value;
    }
  }
  return tokenData.value;
}

export function turnDetectionFromToken(
  minted?: { eagerness?: unknown; interrupt_response?: unknown },
): RealtimeTurnDetection {
  return {
    type: "semantic_vad",
    eagerness: typeof minted?.eagerness === "string" && minted.eagerness
      ? minted.eagerness
      : "medium",
    create_response: true,
    interrupt_response: minted?.interrupt_response !== false,
  };
}
