import fs from "fs";
import path from "path";
import { resolveProjectRoot } from "./paths";

interface ChainConfigLike {
  isRemote?: boolean;
  observerUrls?: string[];
}

interface PeerObserverSelectionOptions {
  selfObserverUrl?: string;
  rootDir?: string;
}

const cachedPeerObserverUrlsByKey = new Map<string, string[]>();

function readObserverConfigFromChainConfig(rootDir: string): { isRemote: boolean; observerUrls: string[] } {
  const configPath = path.join(rootDir, "chain-config.json");
  if (!fs.existsSync(configPath)) {
    return { isRemote: false, observerUrls: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as ChainConfigLike;
    const isRemote = raw.isRemote === true;
    const observerUrls = Array.isArray(raw.observerUrls)
      ? raw.observerUrls.map((entry) => `${entry || ""}`.trim()).filter(Boolean)
      : [];
    return { isRemote, observerUrls };
  } catch {
    return { isRemote: false, observerUrls: [] };
  }
}

export function buildObserverUrls(parties: number, rootDir = resolveProjectRoot()): string[] {
  const { isRemote, observerUrls } = readObserverConfigFromChainConfig(rootDir);
  if (isRemote) {
    if (observerUrls.length === 0) {
      throw new Error(
        '[observerPeers] isRemote is true but observerUrls is empty in chain-config.json',
      );
    }
    return observerUrls;
  }
  if (observerUrls.length > 0) {
    return observerUrls;
  }

  const count = Math.max(1, parties);
  return Array.from({ length: count }, (_, index) => `http://127.0.0.1:${8101 + index}`);
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

