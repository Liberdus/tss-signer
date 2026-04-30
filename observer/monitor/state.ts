import fs from "fs";

// ---------------------------------------------------------------------------
// Monitor state — persisted to a per-party block_state file
// ---------------------------------------------------------------------------

export interface MonitorState {
  vault: Record<string, number>;
  blocks: Record<string, number>;
  bridgeInBlocks: Record<string, number>;
  lastLiberdusTimestamp: number;
  // Failed tx detection — keyed by chainId string
  failedTxScanBlocks: Record<string, number>;
  // Last known on-chain nonce per sender — keyed by `${chainId}:${tssSender}`
  failedTxNonces: Record<string, number>;
}

type LegacyMonitorState = Partial<MonitorState> & {
  revertScanBlocks?: Record<string, number>;
  revertedNonces?: Record<string, number>;
};

// Mutable singleton — mutated directly by ethereum.ts and liberdus.ts
export const monitorState: MonitorState = {
  vault: {},
  blocks: {},
  bridgeInBlocks: {},
  lastLiberdusTimestamp: Date.now(),
  failedTxScanBlocks: {},
  failedTxNonces: {},
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
      const saved: LegacyMonitorState = JSON.parse(
        fs.readFileSync(statePath, "utf8")
      );
      Object.assign(monitorState, saved);
      if (!monitorState.bridgeInBlocks) monitorState.bridgeInBlocks = {};
      if (saved.failedTxScanBlocks == null && saved.revertScanBlocks) {
        monitorState.failedTxScanBlocks = saved.revertScanBlocks;
      }
      if (saved.failedTxNonces == null && saved.revertedNonces) {
        monitorState.failedTxNonces = saved.revertedNonces;
      }
      if (!monitorState.failedTxScanBlocks) monitorState.failedTxScanBlocks = {};
      if (!monitorState.failedTxNonces) monitorState.failedTxNonces = {};
      if (saved.revertScanBlocks || saved.revertedNonces) {
        delete (monitorState as LegacyMonitorState).revertScanBlocks;
        delete (monitorState as LegacyMonitorState).revertedNonces;
        saveMonitorState();
      }
    } catch (e) {
      console.warn("[observer/monitor] Failed to load monitor state, using defaults:", e);
    }
  }
}

// Synchronous write so concurrent calls from the BridgeOut/BridgeIn and Liberdus
// schedulers never produce interleaved or stale snapshots on disk.
export function saveMonitorState(): void {
  if (!monitorStatePath) {
    console.warn("[observer/monitor] saveMonitorState called before initMonitorState");
    return;
  }
  try {
    fs.writeFileSync(monitorStatePath, JSON.stringify(monitorState), "utf8");
  } catch (e) {
    console.error("[observer/monitor] Failed to save monitor state:", e);
  }
}
