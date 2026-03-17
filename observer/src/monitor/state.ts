import fs from "fs";
import fsPromises from "fs/promises";

// ---------------------------------------------------------------------------
// Monitor state — persisted to a per-party block_state file
// ---------------------------------------------------------------------------

export interface MonitorState {
  vault: Record<string, number>;
  blocks: Record<string, number>;
  bridgeInBlocks: Record<string, number>;
  lastLiberdusTimestamp: number;
}

// Mutable singleton — mutated directly by ethereum.ts and liberdus.ts
export const monitorState: MonitorState = {
  vault: {},
  blocks: {},
  bridgeInBlocks: {},
  lastLiberdusTimestamp: Date.now(),
};

// In-memory sync readiness flag — set to true after initial ordered sync
export let syncReady = false;
export function setSyncReady(): void {
  syncReady = true;
}

// Path is set once at startup via initMonitorState
let monitorStatePath = "";

export function initMonitorState(statePath: string): void {
  monitorStatePath = statePath;

  if (fs.existsSync(statePath)) {
    try {
      const saved: Partial<MonitorState> = JSON.parse(
        fs.readFileSync(statePath, "utf8")
      );
      Object.assign(monitorState, saved);
      if (!monitorState.bridgeInBlocks) monitorState.bridgeInBlocks = {};
    } catch (e) {
      console.warn("[observer/monitor] Failed to load monitor state, using defaults:", e);
    }
  }
}

export async function saveMonitorState(): Promise<void> {
  if (!monitorStatePath) {
    console.warn("[observer/monitor] saveMonitorState called before initMonitorState");
    return;
  }
  try {
    await fsPromises.writeFile(monitorStatePath, JSON.stringify(monitorState), "utf8");
  } catch (e) {
    console.error("[observer/monitor] Failed to save monitor state:", e);
  }
}
