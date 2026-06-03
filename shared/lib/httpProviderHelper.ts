import { ethers } from "ethers";
import { redactRpcUrlForLog } from "./redactForLog";
import {
  getProviderNameForUrl,
  isEthGetLogsRangeLimitError,
  markUrlFailed,
  pickAvailableUrlFromList,
  scrubUrls,
  shouldBlacklistForError,
} from "./rpcUrls";
import { toNetworkChainId } from "../config";

function providerLabelForUrl(url: string): string {
  try {
    return getProviderNameForUrl(url) ?? new URL(url).hostname;
  } catch {
    return getProviderNameForUrl(url) ?? "unknown";
  }
}

function logHttpProviderSelection(
  message: string,
  url: string,
  chainId?: number,
): void {
  const provider = providerLabelForUrl(url);
  const redactedUrl = redactRpcUrlForLog(url);
  if (chainId != null) {
    console.log(`[httpProvider] ${message} chain=${chainId} provider=${provider} url=${redactedUrl}`);
    return;
  }
  console.log(`[httpProvider] ${message} provider=${provider} url=${redactedUrl}`);
}

const { providers } = ethers;
export interface GetProviderOptions {
  fallbackRpcUrl?: string;
  chainId?: number;
}

export interface WithRetryOptions extends GetProviderOptions {
  maxRetries?: number;
  logUrl?: boolean;
  timeoutMs?: number;
}

export interface WithCachedRetryOptions extends WithRetryOptions {
  logCache?: boolean;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (timeoutMs == null || timeoutMs <= 0) return promise

  let timeoutHandle: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`HTTP provider call timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}


export function getHttpProviderForChain(
  httpUrls: string[],
  options: GetProviderOptions = {},
): ethers.providers.JsonRpcProvider {
  const url =
    httpUrls.length > 0 ? pickAvailableUrlFromList(httpUrls) : options.fallbackRpcUrl;
  if (!url) throw new Error("No HTTP RPC URL available and no fallback");

  const network =
    options.chainId != null
      ? { chainId: toNetworkChainId(options.chainId), name: "unknown" }
      : undefined;
  return new providers.JsonRpcProvider(url, network);
}


export async function withHttpProviderRetry<T>(
  httpUrls: string[],
  fn: (provider: ethers.providers.JsonRpcProvider) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const maxRetries = Math.max(1, options.maxRetries ?? 3);
  const fallback = options.fallbackRpcUrl;
  const urls = httpUrls.length > 0 ? httpUrls : fallback ? [fallback] : [];
  if (urls.length === 0) throw new Error("No HTTP RPC URLs available");

  let lastError: unknown;
  const excludedUrls = new Set<string>();
  /** Max tries when skipping providers that reject eth_getLogs block range. */
  const ethLogRetries = Math.max(maxRetries, urls.length);

  for (let attempt = 0; attempt < ethLogRetries; attempt++) {
    const url = pickAvailableUrlFromList(urls, excludedUrls);
    const provider = getHttpProviderForChain([url], {
      fallbackRpcUrl: fallback,
      chainId: options.chainId,
    });
    if (options.logUrl) logHttpProviderSelection("URL", url);

    try {
      return await withTimeout(fn(provider), options.timeoutMs);
    } catch (error) {
      lastError = error;
      if (isEthGetLogsRangeLimitError(error)) {
        excludedUrls.add(url);
        const name = getProviderNameForUrl(url) ?? new URL(url).hostname;
        console.warn(
          `[httpProvider] Skipping provider (eth_getLogs block-range limit) provider=${name}`,
        );
        if (attempt < ethLogRetries - 1 && excludedUrls.size < urls.length) continue;
        throw error;
      }
      if (shouldBlacklistForError(error)) {
        const reason = scrubUrls((error as Error)?.message?.slice(0, 120) ?? String(error).slice(0, 120));
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
  const excludedUrls = new Set<string>();
  /** Max tries when skipping providers that reject eth_getLogs block range. */
  const ethLogRetries = Math.max(maxRetries, urls.length);

  for (let attempt = 0; attempt < ethLogRetries; attempt++) {
    let entry = providerCache.get(chainId);
    if (!entry || excludedUrls.has(entry.url)) {
      const url = pickAvailableUrlFromList(urls, excludedUrls);
      const provider = getHttpProviderForChain([url], { fallbackRpcUrl: fallback, chainId });
      entry = { provider, url };
      providerCache.set(chainId, entry);
      if (options.logCache) {
        logHttpProviderSelection("Selected provider", url, chainId);
      }
    }

    if (options.logUrl && !options.logCache) {
      logHttpProviderSelection("URL", entry.url, chainId);
    }

    try {
      return await withTimeout(fn(entry.provider), options.timeoutMs);
    } catch (error) {
      lastError = error;
      const errorMessage = (error as Error)?.message ?? String(error);
      if (isEthGetLogsRangeLimitError(error)) {
        excludedUrls.add(entry.url);
        providerCache.delete(chainId);
        const name = getProviderNameForUrl(entry.url) ?? new URL(entry.url).hostname;
        console.warn(
          `[httpProvider] Skipping provider (eth_getLogs block-range limit) chain=${chainId} provider=${name}`,
        );
        if (attempt < ethLogRetries - 1 && excludedUrls.size < urls.length) continue;
        throw error;
      }
      if (shouldBlacklistForError(error)) {
        const reason = scrubUrls(errorMessage.slice(0, 120));
        markUrlFailed(entry.url, undefined, reason);
      }
      const evictedName = getProviderNameForUrl(entry.url) ?? new URL(entry.url).hostname;
      providerCache.delete(chainId);
      console.warn(`[httpProvider] Invalidated cached provider chain=${chainId} provider=${evictedName}:`, scrubUrls(errorMessage));
      if (attempt < maxRetries - 1) continue;
      if (maxRetries > 1) {
        console.warn(
          `[httpProvider] Failed after ${attempt + 1}/${maxRetries} attempts`,
        );
      }
      throw error;
    }
  }

  throw lastError;
}
