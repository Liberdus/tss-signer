import express from "express";
import cors from "cors";
import * as TransactionDB from "./storage/transactiondb";
import { registerRoutes } from "./routes";
import { chainConfigsRaw } from "./config";
import { initMonitorState, monitorState } from "./monitor/state";
import { monitorEthereumTransactionsQueryFilter } from "./monitor/ethereum";
import { monitorLiberdusTransactions } from "./monitor/liberdus";
import { startDriftResistantScheduler } from "./utils/scheduler";

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
const ETH_MONITOR_INTERVAL_MS = 10_000;  // 10 seconds
const LIB_MONITOR_INTERVAL_MS = 10_000;  // 10 seconds

(async () => {
  try {
    await TransactionDB.initializeTransactionsDatabase();

    initMonitorState();
    console.log(
      "[monitor] Loaded monitor state. Last Liberdus timestamp:",
      new Date(monitorState.lastLiberdusTimestamp).toISOString()
    );

    startDriftResistantScheduler(
      monitorEthereumTransactionsQueryFilter,
      ETH_MONITOR_INTERVAL_MS
    );
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
