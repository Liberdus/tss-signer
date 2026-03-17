import express from "express";
import cors from "cors";
import { registerRoutes } from "./routes";
import { logCoordinatorAuthConfig } from "./auth";

function enableTimestampedConsoleLogs(): void {
  const methods: Array<"log" | "info" | "warn" | "error"> = [
    "log",
    "info",
    "warn",
    "error",
  ];
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: any[]) => {
      original(`[${new Date().toISOString()}]`, ...args);
    };
  }
}

enableTimestampedConsoleLogs();
logCoordinatorAuthConfig();

const app = express();
app.use(cors({ origin: true, methods: ["GET", "POST", "PATCH"], credentials: true }));
app.use(express.json());

registerRoutes(app);

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8000;

app.listen(PORT, () => {
  console.log(`[coordinator] Relay server running on http://localhost:${PORT}`);
});
