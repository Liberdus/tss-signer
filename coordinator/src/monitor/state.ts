import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Monitor state — persisted to block_state.json
// ---------------------------------------------------------------------------

export interface MonitorState {
  vault: Record<string, number>;  // chainId → last checked block (vault mode contracts)
  blocks: Record<string, number>; // chainId → last checked block (supportedChains contracts)
  lastLiberdusTimestamp: number;  // unix ms of last processed Liberdus tx
}

// Path relative to compiled output (coordinator/dist/monitor/ → coordinator/)
const MONITOR_STATE_PATH = path.join(
  __dirname,
  "../../block_state.json"
);

// Mutable singleton — mutated directly by ethereum.ts and liberdus.ts
export const monitorState: MonitorState = {
  vault: {},
  blocks: {},
  lastLiberdusTimestamp: Date.now(),
};

export function initMonitorState(): void {
  if (fs.existsSync(MONITOR_STATE_PATH)) {
    try {
      const saved: MonitorState = JSON.parse(
        fs.readFileSync(MONITOR_STATE_PATH, "utf8")
      );
      Object.assign(monitorState, saved);
    } catch (e) {
      console.warn("[monitor] Failed to load monitor state, using defaults:", e);
    }
  }
}

export function saveMonitorState(): void {
  try {
    fs.writeFileSync(MONITOR_STATE_PATH, JSON.stringify(monitorState), "utf8");
  } catch (e) {
    console.error("[monitor] Failed to save monitor state:", e);
  }
}
