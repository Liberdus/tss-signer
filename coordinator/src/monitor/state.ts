import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

// ---------------------------------------------------------------------------
// Monitor state — persisted to block_state.json
// ---------------------------------------------------------------------------

export interface MonitorState {
  vault: Record<string, number>;                    // chainId → last checked block (vault mode BridgedOut)
  blocks: Record<string, number>;                   // chainId → last checked block (Liberdus mode BridgedOut)
  bridgeInBlocks: Record<string, number>;           // chainId → last checked block (BridgedIn events)
  liberdusTimestampByChain: Record<string, number>; // chainId → unix ms of last processed Liberdus tx
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
  bridgeInBlocks: {},
  liberdusTimestampByChain: {},
};

// Set to true once the initial ordered scan (BridgedOut → Liberdus → BridgedIn)
// completes on startup.  While false, GET /transaction for pending/unprocessed
// transactions returns empty to prevent parties from picking up transactions
// that are already completed on-chain.
export let syncReady = false;
export function setSyncReady(): void {
  syncReady = true;
}

export function initMonitorState(): void {
  if (fs.existsSync(MONITOR_STATE_PATH)) {
    try {
      const saved: Partial<MonitorState> = JSON.parse(
        fs.readFileSync(MONITOR_STATE_PATH, "utf8")
      );
      Object.assign(monitorState, saved);
      // Ensure bridgeInBlocks exists for older state files that predate this field
      if (!monitorState.bridgeInBlocks) monitorState.bridgeInBlocks = {};
      // Ensure lastLiberdusTimestampPerChain exists for older state files that predate this field
      if (!monitorState.liberdusTimestampByChain) monitorState.liberdusTimestampByChain = {};
    } catch (e) {
      console.warn("[monitor] Failed to load monitor state, using defaults:", e);
    }
  }
}

export async function saveMonitorState(): Promise<void> {
  const tmp = MONITOR_STATE_PATH + ".tmp";
  try {
    await fsPromises.writeFile(tmp, JSON.stringify(monitorState), "utf8");
    await fsPromises.rename(tmp, MONITOR_STATE_PATH);
  } catch (e) {
    console.error("[monitor] Failed to save monitor state:", e);
  }
}
