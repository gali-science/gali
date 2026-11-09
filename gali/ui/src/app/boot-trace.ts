const started = performance.now();
const steps: string[] = [];

/** Timestamped boot steps, so a splash that never clears says where it stopped. */
export function bootTrace(step: string): void {
  steps.push(`${((performance.now() - started) / 1000).toFixed(1)}s ${step}`);
}

export function bootTraceText(): string {
  return steps.join("; ");
}
