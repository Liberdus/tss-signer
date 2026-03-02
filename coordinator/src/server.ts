import express from "express";
import cors from "cors";
import * as TransactionDB from "./storage/transactiondb";
import { registerRoutes } from "./routes";
import { chainConfigsRaw } from "./config";
import { initMonitorState, monitorState } from "./monitor/state";
import {
  monitorEthereumBridgeOutQueryFilter,
  monitorEthereumBridgeInQueryFilter,
} from "./monitor/ethereum";
import { monitorLiberdusTransactions } from "./monitor/liberdus";
import { startDriftResistantScheduler } from "./utils/scheduler";
import { setSyncReady } from "./monitor/state";

const app = express();
app.use(
  cors({ origin: true, methods: ["GET", "POST", "PATCH"], credentials: true })
);
app.use(express.text({ type: "application/json" }));
app.use(express.json());
app.use((req, _res, next) => {
  if (req.body && typeof req.body === "string") {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {
      console.warn("Failed to parse JSON body", e);
    }
  }
  next();
});

registerRoutes(app);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8000;
const ETH_MONITOR_INTERVAL_MS = 60 * 1000;  // 1 minute
const LIB_MONITOR_INTERVAL_MS = 10_000;  // 10 seconds

(async () => {
  try {
    await TransactionDB.initializeTransactionsDatabase();

    initMonitorState();
    console.log(
      "[monitor] Loaded monitor state. Last Liberdus timestamp:",
      new Date(monitorState.lastLiberdusTimestamp).toISOString()
    );

    // ---------------------------------------------------------------------------
    // Initial ordered sync before accepting pending transaction queries.
    //
    // Order matters on a cold start or restart:
    //   1. BridgedOut  — creates PENDING BRIDGE_OUT/BRIDGE_VAULT transactions from
    //                    source-side burn events (EVM → Liberdus or vault chain).
    //   2. Liberdus    — creates PENDING BRIDGE_IN transactions for coin-to-token txs
    //                    (BRIDGE_IN txId = Liberdus txId); marks the correlated
    //                    EVM deposit COMPLETED or adds entry as COMPLETED for token-to-coin txs.
    //   3. BridgedIn   — marks transactions COMPLETED; if the source record already
    //                    exists it updates its status; if not, it early-saves it as
    //                    COMPLETED so parties never re-process it.
    //
    // Running BridgedIn last (after the source scanners) maximises the chance that
    // the source record already exists, avoiding early-saves that need later
    // source correction.  syncReady is set only after all three complete, which
    // prevents GET /transaction?status=PENDING from returning transactions that are
    // already completed on-chain.
    // ---------------------------------------------------------------------------
    console.log("[monitor] Initial sync: scanning BridgedOut events...");
    await monitorEthereumBridgeOutQueryFilter();

    if (chainConfigsRaw.enableLiberdusNetwork) {
      console.log("[monitor] Initial sync: scanning Liberdus transactions...");
      await monitorLiberdusTransactions();
    }

    console.log("[monitor] Initial sync: scanning BridgedIn events...");
    await monitorEthereumBridgeInQueryFilter();

    setSyncReady();
    console.log(
      "[monitor] Initial sync complete — accepting pending transaction queries."
    );

    // Periodic schedulers: BridgedOut and BridgedIn are always run as a
    // sequential pair so the source record exists before the completion scan.
    startDriftResistantScheduler(async () => {
      await monitorEthereumBridgeOutQueryFilter();
      await monitorEthereumBridgeInQueryFilter();
    }, ETH_MONITOR_INTERVAL_MS);

    if (chainConfigsRaw.enableLiberdusNetwork) {
      startDriftResistantScheduler(
        monitorLiberdusTransactions,
        LIB_MONITOR_INTERVAL_MS
      );
    }

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to initialize the application:", err);
    process.exit(1);
  }
})();
