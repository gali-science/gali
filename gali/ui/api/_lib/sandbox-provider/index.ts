import { vercelProvider } from "./vercel/provider.js";
import type { SandboxProvider, SandboxProviderKind } from "./types.js";

export * from "./types.js";

const PROVIDERS: Record<SandboxProviderKind, SandboxProvider> = {
  vercel: vercelProvider,
};

export function sandboxProvider(kind: SandboxProviderKind): SandboxProvider {
  return PROVIDERS[kind];
}
