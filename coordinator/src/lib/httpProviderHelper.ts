import { ethers } from "ethers";
import { markUrlFailed, pickAvailableUrlFromList, shouldBlacklistForError } from "./rpcUrls";

const { providers } = ethers;

export interface WithCachedRetryOptions {
  fallbackRpcUrl?: string;
  maxRetries?: number;
  logUrl?: boolean;
  logCache?: boolean;
}

function getHttpProviderForChain(
  httpUrls: string[],
  chainId: number,
  fallbackRpcUrl?: string
): { provider: ethers.providers.JsonRpcProvider; url: string } {
  const url = httpUrls.length > 0 ? pickAvailableUrlFromList(httpUrls) : fallbackRpcUrl;
  if (!url) throw new Error(`No HTTP RPC URL available for chainId ${chainId}`);

  const network = { chainId, name: "unknown" };
  return { provider: new providers.JsonRpcProvider(url, network), url };
}

const providerCache = new Map<number, { provider: ethers.providers.JsonRpcProvider; url: string }>();

export function invalidateCachedProvider(chainId: number): void {
  providerCache.delete(chainId);
}

export async function withCachedHttpProvider<T>(
  chainId: number,
  httpUrls: string[],
  fn: (provider: ethers.providers.JsonRpcProvider) => Promise<T>,
  options: WithCachedRetryOptions = {}
): Promise<T> {
  const maxRetries = Math.max(1, options.maxRetries ?? 3);
  const fallback = options.fallbackRpcUrl;
  const urls = httpUrls.length > 0 ? httpUrls : fallback ? [fallback] : [];
  if (urls.length === 0) throw new Error(`No HTTP RPC URLs available for chainId ${chainId}`);

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let entry = providerCache.get(chainId);
    if (!entry) {
      entry = getHttpProviderForChain(urls, chainId, fallback);
      providerCache.set(chainId, entry);
      if (options.logCache) {
        console.log(`[coordinator/httpProvider] New cached provider chain=${chainId} url=${entry.url}`);
      }
    }
    if (options.logUrl && !options.logCache) {
      console.log(`[coordinator/httpProvider] URL: ${entry.url}`);
    }

    try {
      return await fn(entry.provider);
    } catch (error) {
      lastError = error;
      if (shouldBlacklistForError(error)) {
        const reason = (error as Error)?.message?.slice(0, 120) ?? String(error).slice(0, 120);
        markUrlFailed(entry.url, undefined, reason);
      }
      providerCache.delete(chainId);
      if (options.logCache) {
        console.warn(
          `[coordinator/httpProvider] Invalidated cached provider chain=${chainId}:`,
          (error as Error)?.message ?? error
        );
      }
      if (attempt < maxRetries - 1) continue;
      throw error;
    }
  }

  throw lastError;
}
