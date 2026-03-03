import axios from "axios";

const CHAINLIST_RPCS_URL = "https://chainlist.org/rpcs.json";
const HOURLY_MS = 60 * 60 * 1000;

const httpRpcUrlsByChain = new Map<number, string[]>();
const urlBlacklistExpiry = new Map<string, number>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function normalizeRpcUrl(url: string): string {
  const trimmed = (url || "").trim();
  return trimmed;
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
    console.warn("[coordinator/rpcUrls] Chainlist fetch failed:", error?.message || error);
  }
}

export function startHourlyChainlistFetch(
  supportedChainIds: number[]
): () => void {
  fetchChainlistAndMerge(supportedChainIds).then(() => {
    console.log("[coordinator/rpcUrls] Initial chainlist fetch completed");
  });

  const interval = setInterval(() => {
    fetchChainlistAndMerge(supportedChainIds).then(() => {
      if (process.env.NODE_ENV !== "test") {
        console.log("[coordinator/rpcUrls] Hourly chainlist merge completed");
      }
    });
  }, HOURLY_MS);

  return () => clearInterval(interval);
}

export function markUrlFailed(url: string, ttlMs?: number, reason?: string): void {
  urlBlacklistExpiry.set(url, Date.now() + (ttlMs ?? DEFAULT_TTL_MS));
  const reasonText = reason ? ` reason=${reason}` : "";
  console.warn(
    `[coordinator/rpcUrls] Blacklisted RPC URL for ${((ttlMs ?? DEFAULT_TTL_MS) / 60000).toFixed(1)}m:${reasonText} ${url}`
  );
}

export function pickAvailableUrlFromList(urls: string[]): string {
  const maxAttempts = urls.length;
  let fallback = urls[0];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = urls[Math.floor(Math.random() * urls.length)];
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
  const msg = String((error as any)?.message ?? (error as any)?.code ?? error).toLowerCase();
  const code = (error as any)?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET") return true;
  if (code === "NETWORK_ERROR") return true;
  if (/could not detect network|no network|nonetwork/i.test(msg)) return true;
  if (code === "ETIMEDOUT") return false;
  if (/timeout|timed out/i.test(msg)) return false;
  if (/429|rate limit|too many requests|throttl/i.test(msg)) return false;
  if (/5\d{2}/.test(String((error as any)?.status ?? (error as any)?.response?.status ?? "")))
    return true;
  if (/5\d{2}/.test(msg)) return true;
  if (/econnrefused|enotfound|econnreset/i.test(msg)) return true;
  if (/invalid response|parse error|unexpected token/i.test(msg)) return true;
  return false;
}

export function getHttpUrls(chainId: number): string[] {
  return httpRpcUrlsByChain.get(chainId) ?? [];
}
