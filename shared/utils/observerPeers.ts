import fs from "fs";
import https from "https";
import path from "path";
import { resolveProjectRoot } from "./paths";

interface ChainConfigLike {
  isRemote?: boolean;
}

interface PeerObserverSelectionOptions {
  selfObserverUrl?: string;
  rootDir?: string;
}

const cachedPeerObserverUrlsByKey = new Map<string, string[]>();
const OBSERVER_LIST_FILE = 'observer-list.json';
const PUBLIC_IP_LOOKUP_URLS = [
  "https://api.ipify.org",
  "https://ifconfig.me/ip",
];

function localObserverUrl(partyIdx: number): string {
  return `http://127.0.0.1:${8100 + partyIdx}`;
}

function parseObserverList(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`[config] ${OBSERVER_LIST_FILE} must be a JSON array of observer URLs`);
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(`[config] ${OBSERVER_LIST_FILE}[${index}] must be a string`);
    }
    return entry.trim();
  }).filter(Boolean);
}

export function loadObserverUrlsFromRoot(rootDir = resolveProjectRoot()): string[] {
  const observerListPath = path.join(rootDir, OBSERVER_LIST_FILE);
  if (!fs.existsSync(observerListPath)) {
    return [];
  }
  try {
    return parseObserverList(JSON.parse(fs.readFileSync(observerListPath, "utf8")));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`[config] ${OBSERVER_LIST_FILE} contains invalid JSON: ${e.message}`);
    }
    throw e;
  }
}

function readRemoteFlagFromChainConfig(rootDir: string): boolean {
  const configPath = path.join(rootDir, "chain-config.json");
  if (!fs.existsSync(configPath)) {
    return false;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as ChainConfigLike;
    return raw.isRemote === true;
  } catch {
    return false;
  }
}

export function buildObserverUrls(parties: number, rootDir = resolveProjectRoot()): string[] {
  const isRemote = readRemoteFlagFromChainConfig(rootDir);
  const observerUrls = loadObserverUrlsFromRoot(rootDir);
  if (isRemote) {
    if (observerUrls.length === 0) {
      throw new Error(
        '[observerPeers] isRemote is true but observer-list.json is missing or empty',
      );
    }
    return observerUrls;
  }
  if (observerUrls.length > 0) {
    return observerUrls;
  }

  const count = Math.max(1, parties);
  return Array.from({ length: count }, (_, index) => localObserverUrl(index + 1));
}

function normalizeObserverUrl(rawUrl?: string): string | null {
  const candidate = `${rawUrl ?? ""}`.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.href.replace(/\/$/, "");
  } catch {
    return candidate.replace(/\/$/, "");
  }
}

function findObserverUrlByHost(observerUrls: string[], host: string): string | null {
  for (const observerUrl of observerUrls) {
    try {
      const parsed = new URL(observerUrl);
      if (parsed.hostname === host) {
        return normalizeObserverUrl(observerUrl);
      }
    } catch {
      // Invalid observer URLs are rejected by observer-list parsing.
    }
  }
  return null;
}

function fetchText(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: timeoutMs }, (response) => {
      if (response.statusCode == null || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode ?? "unknown"}`));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve(body.trim()));
    });

    request.on("timeout", () => {
      request.destroy(new Error(`Timed out after ${timeoutMs}ms`));
    });
    request.on("error", reject);
  });
}

async function getPublicIp(timeoutMs = 2_000): Promise<string | null> {
  for (const url of PUBLIC_IP_LOOKUP_URLS) {
    try {
      const publicIp = await fetchText(url, timeoutMs);
      if (publicIp) return publicIp;
    } catch {
      // Try the next public IP endpoint.
    }
  }
  return null;
}

export async function deriveSelfObserverUrl(partyIdx: number, options: { isRemote?: boolean; rootDir?: string; observerUrls?: string[] } = {}): Promise<string> {
  const configuredSelfUrl = resolveSelfObserverUrl({});
  if (configuredSelfUrl) {
    return configuredSelfUrl;
  }

  if (options.isRemote === true) {
    const observerUrls = options.observerUrls ?? loadObserverUrlsFromRoot(options.rootDir ?? resolveProjectRoot());
    const publicIp = await getPublicIp();
    const matchingPublicObserverUrl = publicIp
      ? findObserverUrlByHost(observerUrls, publicIp)
      : null;
    if (matchingPublicObserverUrl) return matchingPublicObserverUrl;

    throw new Error(
      `[observerPeers] isRemote is true but could not match this machine's public IP (${publicIp ?? "lookup failed"}) to any entry in observer-list.json. Use public IP addresses in observer-list.json for auto-detection, or set TSS_SELF_OBSERVER_URL to override.`,
    );
  }

  return localObserverUrl(partyIdx);
}

function resolveSelfObserverUrl(options: PeerObserverSelectionOptions): string | null {
  const configuredSelfUrl = options.selfObserverUrl ?? process.env.TSS_SELF_OBSERVER_URL;
  return normalizeObserverUrl(configuredSelfUrl);
}

function resolvePartyIndex(): number | null {
  const parsedPartyIndex = Number.parseInt(`${process.env.PARTY_INDEX ?? ""}`.trim(), 10);
  if (!Number.isInteger(parsedPartyIndex) || parsedPartyIndex < 1) return null;
  return parsedPartyIndex;
}

export function getPeerObserverUrls(parties: number, options: PeerObserverSelectionOptions = {}): string[] {
  const rootDir = options.rootDir ?? resolveProjectRoot();
  const urls = buildObserverUrls(parties, rootDir);
  const selfObserverUrl = resolveSelfObserverUrl(options);
  if (selfObserverUrl) {
    return urls.filter((url) => normalizeObserverUrl(url) !== selfObserverUrl);
  }

  const partyIndex = resolvePartyIndex();
  if (partyIndex != null) {
    const selfIndex = partyIndex - 1;
    return urls.filter((_, index) => index !== selfIndex);
  }

  return urls;
}

export function getCachedPeerObserverUrls(parties: number, options: PeerObserverSelectionOptions = {}): string[] {
  const rootDir = options.rootDir ?? resolveProjectRoot();
  const selfObserverUrl = resolveSelfObserverUrl(options);
  const partyIndex = resolvePartyIndex();
  const identityKey = selfObserverUrl
    ? `url:${selfObserverUrl}`
    : `index:${partyIndex ?? "none"}`;

  const cacheKey = `${parties}|${rootDir}|${identityKey}`;
  const cached = cachedPeerObserverUrlsByKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  const computed = getPeerObserverUrls(parties, { ...options, rootDir });
  cachedPeerObserverUrlsByKey.set(cacheKey, computed);
  return computed;
}

export function resetCachedPeerObserverUrls(): void {
  cachedPeerObserverUrlsByKey.clear();
}
