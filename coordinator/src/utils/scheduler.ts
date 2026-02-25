/**
 * Drift-resistant scheduler that aligns execution to exact second boundaries,
 * preventing gradual timer drift across long-running processes.
 */
export function startDriftResistantScheduler(
  fn: () => void | Promise<void>,
  intervalMS: number
): void {
  console.log(
    `Starting drift-resistant scheduler for ${fn.name} with interval ${intervalMS} ms`
  );
  const intervalSeconds = Math.round(intervalMS / 1000);

  function scheduleNext() {
    const now = new Date();
    const currentSeconds = now.getSeconds();

    // Find next exact boundary (e.g., if every 10s: 0, 10, 20, ..., 50)
    let nextBoundary =
      Math.floor(currentSeconds / intervalSeconds + 1) * intervalSeconds;

    const targetTime = new Date(now);

    if (nextBoundary >= 60) {
      // Go to next minute if needed
      targetTime.setMinutes(targetTime.getMinutes() + 1);
      targetTime.setSeconds(nextBoundary - 60, 0);
    } else {
      targetTime.setSeconds(nextBoundary, 0);
    }

    const delay = targetTime.getTime() - now.getTime();

    setTimeout(() => {
      fn();
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}
