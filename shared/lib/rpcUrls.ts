import axios from "axios";
import { redactRpcUrlForLog } from "./redactForLog";

const CHAINLIST_RPCS_URL = "https://chainlist.org/rpcs.json";
const HOURLY_MS = 60 * 60 * 1000;

const httpRpcUrlsByChain = new Map<number, string[]>();
const urlBlacklistExpiry = new Map<string, number>();
const urlProviderNames = new Map<string, string>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function normalizeRpcUrl(url: string): string {
  return (url || "").trim();
}

/** Replaces every http(s) URL embedded in a string with its masked form. */
export function scrubUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, (match) => redactRpcUrlForLog(match));
}

export interface ChainConfigForUrls {
  rpcUrl: string;
}

export function initFromConfig(
  chainConfigs: Record<string, ChainConfigForUrls>
): void {
  for (const [chainIdStr, config] of Object.entries(chainConfigs)) {
    const chainId = parseInt(chainIdStr, 10);
    if (Number.isNaN(chainId)) continue;

    const httpUrl = normalizeRpcUrl(config.rpcUrl);
    if (!httpUrl) continue;

    const list = httpRpcUrlsByChain.get(chainId) ?? [];
    if (!list.includes(httpUrl)) list.push(httpUrl);
    httpRpcUrlsByChain.set(chainId, list);
  }
}

export function addHttpUrls(
  chainId: number,
  urls: string[],
  options: { prepend?: boolean; providerNames?: string[] } = {}
): void {
  const list = httpRpcUrlsByChain.get(chainId) ?? [];
  const normalized: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    const url = normalizeRpcUrl(urls[i]);
    if (!url) continue;
    if (!(url.startsWith("http://") || url.startsWith("https://"))) continue;
    if (!normalized.includes(url)) normalized.push(url);
    const name = options.providerNames?.[i];
    if (name) urlProviderNames.set(url, name);
  }
  if (normalized.length === 0) return;

  const next = options.prepend ? [...normalized, ...list] : [...list, ...normalized];
  // Deduplicate while preserving order
  const dedup: string[] = [];
  for (const u of next) {
    if (!dedup.includes(u)) dedup.push(u);
  }
  httpRpcUrlsByChain.set(chainId, dedup);
}

export function removeHttpUrls(chainId: number, urls: string[]): number {
  const list = httpRpcUrlsByChain.get(chainId)
  if (!list || list.length === 0 || urls.length === 0) return 0

  const removeSet = new Set(urls.map((url) => normalizeRpcUrl(url)).filter(Boolean))
  const next = list.filter((url) => !removeSet.has(url))
  const removed = list.length - next.length
  if (removed > 0) {
    httpRpcUrlsByChain.set(chainId, next)
  }
  return removed
}

export function mergeChainlistResponse(
  data: unknown,
  supportedChainIds: Set<number>
): void {
  if (!Array.isArray(data)) return;

  for (const item of data as unknown[]) {
    const chainId =
      typeof (item as any)?.chainId === "number" ? (item as any).chainId : undefined;
    if (chainId === undefined || !supportedChainIds.has(chainId)) continue;

    const rpc = (item as any)?.rpc;
    if (!Array.isArray(rpc)) continue;

    const httpList = httpRpcUrlsByChain.get(chainId) ?? [];
    for (const entry of rpc) {
      const raw =
        typeof entry === "string" ? entry : typeof entry?.url === "string" ? entry.url : null;
      if (!raw) continue;

      const url = normalizeRpcUrl(raw.trim());
      if (!url) continue;

      if ((url.startsWith("http://") || url.startsWith("https://")) && !httpList.includes(url)) {
        httpList.push(url);
      }
    }

    if (httpList.length) httpRpcUrlsByChain.set(chainId, httpList);
  }
}

export async function fetchChainlistAndMerge(
  supportedChainIds: number[]
): Promise<void> {
  try {
    const res = await axios.get(CHAINLIST_RPCS_URL, { timeout: 15_000 });
    mergeChainlistResponse(res.data as unknown, new Set(supportedChainIds));
  } catch (error: any) {
    console.warn("[rpcUrls] Chainlist fetch failed:", error?.message || error);
  }
}

export function startHourlyChainlistFetch(
  supportedChainIds: number[]
): () => void {
  fetchChainlistAndMerge(supportedChainIds).then(() => {
    console.log("[rpcUrls] Initial chainlist fetch completed");
  });

  const interval = setInterval(() => {
    fetchChainlistAndMerge(supportedChainIds).then(() => {
      if (process.env.NODE_ENV !== "test") {
        console.log("[rpcUrls] Hourly chainlist merge completed");
      }
    });
  }, HOURLY_MS);

  return () => clearInterval(interval);
}

export function markUrlFailed(url: string, ttlMs?: number, reason?: string): void {
  urlBlacklistExpiry.set(url, Date.now() + (ttlMs ?? DEFAULT_TTL_MS));
  const safeReason = reason ? scrubUrls(reason) : undefined;
  const reasonText = safeReason ? ` reason=${safeReason}` : "";
  console.warn(
    `[rpcUrls] Blacklisted RPC URL for ${((ttlMs ?? DEFAULT_TTL_MS) / 60000).toFixed(1)}m:${reasonText} ${redactRpcUrlForLog(url)}`
  );
  // Prune expired entries to prevent unbounded growth. URLs removed from the
  // active chainlist are never accessed again via pickAvailableUrlFromList, so
  // their entries would otherwise accumulate across hourly refreshes.
  if (urlBlacklistExpiry.size > 100) {
    const now = Date.now();
    for (const [u, exp] of urlBlacklistExpiry) {
      if (now > exp) urlBlacklistExpiry.delete(u);
    }
  }
}

/** Pull RPC code/message from ethers SERVER_ERROR wrappers (body="{\"error\":...}"). */
function collectRpcErrorContext(error: unknown): { code: number | undefined; text: string } {
  const err = error as { message?: string; code?: unknown; error?: { code?: unknown; message?: string } };
  const parts: string[] = [];
  if (err?.message) parts.push(err.message);
  if (err?.error?.message) parts.push(err.error.message);

  let code: number | undefined;
  const nestedCode = err?.error?.code ?? err?.code;
  if (typeof nestedCode === "number") code = nestedCode;
  else if (typeof nestedCode === "string" && /^-?\d+$/.test(nestedCode)) code = Number(nestedCode);

  const bodyMatch = parts.join(" ").match(/body="((?:\\.|[^"\\])*)"/);
  if (bodyMatch) {
    try {
      const bodyJson = JSON.parse(bodyMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")) as {
        error?: { code?: number; message?: string };
      };
      if (bodyJson.error?.message) parts.push(bodyJson.error.message);
      if (typeof bodyJson.error?.code === "number") code = bodyJson.error.code;
    } catch {
      // ignore malformed body
    }
  }

  return { code, text: parts.join(" ").toLowerCase() };
}

/**
 * Provider rejected eth_getLogs because the requested block range exceeds plan limits.
 * Not a bad endpoint — skip to the next provider for this call without blacklisting.
 *
 * Known providers:
 *   - QuickNode Discover: -32615, "eth_getLogs is limited to a N range"
 *   - Alchemy free tier:  -32600, "up to a 10 block range" / "Upgrade to PAYG"
 */
export function isEthGetLogsRangeLimitError(error: unknown): boolean {
  const { code, text } = collectRpcErrorContext(error);
  if (!/eth_getlogs|eth_get_logs/.test(text) && !/block range/.test(text)) {
    return false;
  }

  // QuickNode Discover / free trial
  if (code === -32615) return true;
  if (/eth_getlogs is limited to a \d+ range/.test(text)) return true;
  if (/limited to a \d+ range.*upgrade.*plan|upgrade.*plan.*limited to a \d+ range/.test(text)) {
    return true;
  }

  // Alchemy free tier (Polygon Amoy etc.: 10 blocks; varies by chain on paid tiers)
  if (code === -32600 && /free tier|block range|upgrade to payg/.test(text)) return true;
  if (/under the free tier plan.*eth_getlogs|eth_getlogs.*up to a \d+ block range/.test(text)) {
    return true;
  }
  if (/upgrade to payg for expanded block range/.test(text)) return true;

  // Other providers
  if (/eth_getlogs.*block range|block range.*eth_getlogs/.test(text)) return true;
  if (/query returned more than \d+ blocks|block range too (large|wide)/.test(text)) return true;

  return false;
}

export function pickAvailableUrlFromList(
  urls: string[],
  exclude?: ReadonlySet<string>,
): string {
  const pool =
    exclude && exclude.size > 0 ? urls.filter((u) => !exclude.has(u)) : urls;
  if (pool.length === 0) {
    throw new Error("[rpcUrls] No RPC URLs available after excluding providers for eth_getLogs range limit");
  }

  const maxAttempts = pool.length;
  let fallback = pool[0];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = pool[Math.floor(Math.random() * pool.length)];
    fallback = url;
    const expiry = urlBlacklistExpiry.get(url);
    if (expiry === undefined) return url;
    if (Date.now() > expiry) {
      urlBlacklistExpiry.delete(url);
      return url;
    }
  }
  return fallback;
}

export function shouldBlacklistForError(error: unknown): boolean {
  if (isEthGetLogsRangeLimitError(error)) return false;

  const msg = String((error as any)?.message ?? (error as any)?.code ?? error).toLowerCase();
  const code = (error as any)?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET") return true;
  if (code === "NETWORK_ERROR") return true;
  if (/could not detect network|no network|nonetwork/i.test(msg)) return true;
  if (code === "ETIMEDOUT") return false;
  if (/timeout|timed out/i.test(msg)) return false;
  if (/429|rate limit|too many requests|throttl/i.test(msg)) return false;
  // Transaction-state errors usually indicate a valid node response rather than
  // a bad RPC endpoint, even when some providers wrap them in HTTP 5xx.
  if (
    /nonce too low|nonce has already been used|nonce expired|already known|replacement transaction underpriced/i.test(msg)
  ) {
    return false;
  }
  if (/5\d{2}/.test(String((error as any)?.status ?? (error as any)?.response?.status ?? "")))
    return true;
  if (/5\d{2}/.test(msg)) return true;
  if (/econnrefused|enotfound|econnreset/i.test(msg)) return true;
  if (/invalid response|parse error|unexpected token/i.test(msg)) return true;
  // RPC returned malformed/null response — TypeError thrown inside ethers.js internals
  if (error instanceof TypeError) return true;
  return false;
}

export function getHttpUrls(chainId: number): string[] {
  return httpRpcUrlsByChain.get(chainId) ?? [];
}

export function getProviderNameForUrl(url: string): string | undefined {
  return urlProviderNames.get(url);
}
