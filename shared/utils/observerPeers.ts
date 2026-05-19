import fs from "fs";
import https from "https";
import path from "path";
import { chainConfigsRaw, paramsConfigRaw } from "../config";
import { resolveProjectRoot } from "./paths";

interface PeerObserverSelectionOptions {
  selfObserverUrl?: string;
}

export type ObserverPeerConfig = {
  observerUrls: string[];
  partyCount: number;
}


const OBSERVER_LIST_FILE = 'observer-list.json';

let configuredSelfObserverUrl: string | undefined;

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
    return normalizeObserverUrl(entry);
  }).filter((entry): entry is string => entry !== null);
}

export function loadObserverUrlsConfig(rootDir = resolveProjectRoot()): string[] {
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

export function buildObserverPeerConfig(observerUrls: string[], parties: number): ObserverPeerConfig {
  return {
    observerUrls,
    partyCount: observerUrls.length > 0
      ? observerUrls.length
      : parties,
  }
}


export function buildObserverUrls(): string[] {
  const { observerUrls, partyCount } = observerPeerConfigRaw;
  if (observerUrls.length > 0) {
    return observerUrls;
  }

  return Array.from({ length: partyCount }, (_, index) => localObserverUrl(index + 1));
}

function validateObserverSetup(observerUrls: string[]): void {
  if (typeof chainConfigsRaw.isRemote !== 'undefined' && typeof chainConfigsRaw.isRemote !== 'boolean') {
    throw new Error('[config] isRemote must be a boolean when provided');
  }
  if (chainConfigsRaw.isRemote === true && observerUrls.length === 0) {
    throw new Error(
      '[config] isRemote is true but observer-list.json is missing or empty. Configure observer-list.json for remote deployments.',
    );
  }
}

export function normalizeObserverUrl(rawUrl?: string): string | null {
  const candidate = `${rawUrl ?? ""}`.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function findObserverUrlByHost(observerUrls: string[], host: string): string | null {
  for (const observerUrl of observerUrls) {
    try {
      const parsed = new URL(observerUrl);
      if (parsed.hostname === host) {
        return observerUrl;
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

export async function deriveSelfObserverUrl(partyIdx: number): Promise<string> {
  const configuredSelfUrl = resolveSelfObserverUrl({});
  if (configuredSelfUrl) {
    return configuredSelfUrl;
  }

  const { observerUrls } = observerPeerConfigRaw;
  if (chainConfigsRaw.isRemote === true) {
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
  const configuredSelfUrl = options.selfObserverUrl ?? configuredSelfObserverUrl ?? process.env.TSS_SELF_OBSERVER_URL;
  return normalizeObserverUrl(configuredSelfUrl);
}

export function setSelfObserverUrl(url: string): void {
  configuredSelfObserverUrl = normalizeObserverUrl(url) ?? undefined;
}

function resolvePartyIndex(): number | null {
  const parsedPartyIndex = Number.parseInt(`${process.env.PARTY_INDEX ?? ""}`.trim(), 10);
  if (!Number.isInteger(parsedPartyIndex) || parsedPartyIndex < 1) return null;
  return parsedPartyIndex;
}

export function getPeerObserverUrls(options: PeerObserverSelectionOptions = {}): string[] {
  const urls = buildObserverUrls();
  const selfObserverUrl = resolveSelfObserverUrl(options);
  if (selfObserverUrl) {
    return urls.filter((url) => url !== selfObserverUrl);
  }

  const partyIndex = resolvePartyIndex();
  if (partyIndex != null) {
    const selfIndex = partyIndex - 1;
    return urls.filter((_, index) => index !== selfIndex);
  }

  return urls;
}

export const observerUrlsRaw = loadObserverUrlsConfig();
validateObserverSetup(observerUrlsRaw);
export const observerPeerConfigRaw = buildObserverPeerConfig(observerUrlsRaw, paramsConfigRaw.parties);
