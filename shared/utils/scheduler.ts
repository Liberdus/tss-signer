/**
 * Drift-resistant scheduler that aligns execution to fixed interval boundaries
 * derived from epoch time rather than process start, preventing gradual timer
 * drift across long-running processes.
 *
 * For async functions, the next run is scheduled only after the current run
 * settles, preventing overlapping executions.
 */
export function startDriftResistantScheduler(
  fn: () => void | Promise<void>,
  intervalMS: number,
): void {
  if (!Number.isFinite(intervalMS) || intervalMS <= 0) {
    throw new Error(`Invalid scheduler interval: ${intervalMS}`);
  }

  console.log(
    `Starting drift-resistant scheduler for ${fn.name} with interval ${intervalMS} ms`,
  );

  function delayUntilNextBoundary(nowMs: number): number {
    const remainder = nowMs % intervalMS;
    return remainder === 0 ? intervalMS : intervalMS - remainder;
  }

  function scheduleNext(): void {
    const delay = delayUntilNextBoundary(Date.now());

    setTimeout(async () => {
      try {
        await fn();
      } catch (err) {
        console.error(`[scheduler] Unhandled error in ${fn.name}:`, err);
      } finally {
        scheduleNext();
      }
    }, delay);
  }

  scheduleNext();
}
