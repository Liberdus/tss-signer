import { ethers } from "ethers";
import { markUrlFailed, pickAvailableUrlFromList, shouldBlacklistForError } from "./rpcUrls";

const { providers } = ethers;

export interface GetProviderOptions {
  fallbackRpcUrl?: string;
  chainId?: number;
}

export function getHttpProviderForChain(
  httpUrls: string[],
  options: GetProviderOptions = {}
): ethers.providers.JsonRpcProvider {
  const url =
    httpUrls.length > 0 ? pickAvailableUrlFromList(httpUrls) : options.fallbackRpcUrl;
  if (!url) throw new Error("No HTTP RPC URL available and no fallback");

  const network =
    options.chainId != null ? { chainId: options.chainId, name: "unknown" } : undefined;
  return new providers.JsonRpcProvider(url, network);
}

export interface WithRetryOptions extends GetProviderOptions {
  maxRetries?: number;
  logUrl?: boolean;
}

export async function withHttpProviderRetry<T>(
  httpUrls: string[],
  fn: (provider: ethers.providers.JsonRpcProvider) => Promise<T>,
  options: WithRetryOptions = {}
): Promise<T> {
  const maxRetries = Math.max(1, options.maxRetries ?? 3);
  const fallback = options.fallbackRpcUrl;
  const urls = httpUrls.length > 0 ? httpUrls : fallback ? [fallback] : [];
  if (urls.length === 0) throw new Error("No HTTP RPC URLs available");

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const url = pickAvailableUrlFromList(urls);
    const provider = getHttpProviderForChain([url], {
      fallbackRpcUrl: fallback,
      chainId: options.chainId,
    });
    if (options.logUrl) console.log(`[httpProvider] URL: ${url}`);

    try {
      return await fn(provider);
    } catch (error) {
      lastError = error;
      if (shouldBlacklistForError(error)) {
        const reason = (error as Error)?.message?.slice(0, 120) ?? String(error).slice(0, 120);
        markUrlFailed(url, undefined, reason);
      }
      if (attempt < maxRetries - 1 && urls.length > 1) continue;
      throw error;
    }
  }

  throw lastError;
}

const providerCache = new Map<number, { provider: ethers.providers.JsonRpcProvider; url: string }>();

export function invalidateCachedProvider(chainId: number): void {
  providerCache.delete(chainId);
}

export interface WithCachedRetryOptions extends WithRetryOptions {
  logCache?: boolean;
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
      const url = pickAvailableUrlFromList(urls);
      const provider = getHttpProviderForChain([url], { fallbackRpcUrl: fallback, chainId });
      entry = { provider, url };
      providerCache.set(chainId, entry);
      if (options.logCache) console.log(`[httpProvider] New cached provider chain=${chainId} url=${url}`);
    }
    if (options.logUrl && !options.logCache) {
      console.log(`[httpProvider] URL: ${entry.url}`);
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
          `[httpProvider] Invalidated cached provider chain=${chainId}:`,
          (error as Error)?.message ?? error
        );
      }
      if (attempt < maxRetries - 1) continue;
      throw error;
    }
  }

  throw lastError;
}
