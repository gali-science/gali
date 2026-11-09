import { AsyncLocalStorage } from "node:async_hooks";
import type { WakeProgressPhase } from "../../../shared/sandbox-health.js";

// Scoped to one ensure request, so the wake code can report a phase without
// every resolver in between threading a callback through.
const listener = new AsyncLocalStorage<(phase: WakeProgressPhase) => void>();

export function withWakeProgress<T>(
  onPhase: (phase: WakeProgressPhase) => void,
  run: () => Promise<T>,
): Promise<T> {
  return listener.run(onPhase, run);
}

export function reportWakeProgress(phase: WakeProgressPhase): void {
  listener.getStore()?.(phase);
}
