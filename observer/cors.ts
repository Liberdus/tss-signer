import type { CorsOptions } from "cors";

/** Exact origins allowed when OBSERVER_CORS_ORIGINS is unset. */
const DEFAULT_EXACT_ORIGINS = new Set([
  "https://dev.liberdus.com",
  "https://liberdus.com",
]);

/** Prefixes for local bridge UI dev servers (any port). */
const LOCAL_DEV_ORIGIN_PREFIXES = ["http://localhost:", "http://127.0.0.1:"];

function parseExtraOriginsFromEnv(): string[] {
  const raw = process.env.OBSERVER_CORS_ORIGINS?.trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function isLocalDevOrigin(origin: string): boolean {
  if (origin === "http://localhost" || origin === "http://127.0.0.1") return true;
  return LOCAL_DEV_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix));
}

function matchesEnvEntry(origin: string, entry: string): boolean {
  if (entry.endsWith("*")) {
    return origin.startsWith(entry.slice(0, -1));
  }
  return origin === entry;
}

/**
 * Returns whether a browser Origin header may receive CORS responses.
 * Configure extra origins via OBSERVER_CORS_ORIGINS (comma-separated; suffix * for prefix match).
 */
export function isAllowedObserverCorsOrigin(
  origin: string,
  extraOrigins: string[] = parseExtraOriginsFromEnv()
): boolean {
  if (DEFAULT_EXACT_ORIGINS.has(origin)) return true;
  if (isLocalDevOrigin(origin)) return true;
  return extraOrigins.some((entry) => matchesEnvEntry(origin, entry));
}

export function createObserverCorsOptions(): CorsOptions {
  const extraOrigins = parseExtraOriginsFromEnv();
  return {
    origin(origin, callback) {
      // Non-browser clients (proxy, curl, gossip) omit Origin; no CORS headers needed.
      if (!origin) {
        callback(null, false);
        return;
      }
      if (isAllowedObserverCorsOrigin(origin, extraOrigins)) {
        callback(null, origin);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "POST"],
    credentials: true,
  };
}
