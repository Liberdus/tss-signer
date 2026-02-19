/**
 * HTTP RPC provider helper: pick a random URL per request and optional retry with another URL.
 */

import {ethers} from 'ethers'

const {providers} = ethers

export interface GetProviderOptions {
  /** Fallback URL when httpUrls is empty */
  fallbackRpcUrl?: string
  /** Pass to JsonRpcProvider to avoid lazy detectNetwork() RPC */
  chainId?: number
}

/**
 * Pick a random HTTP RPC URL from the list (or use fallback), then create a JsonRpcProvider.
 * Not expensive: constructor only stores URL; pass chainId to avoid extra eth_chainId round-trip.
 */
export function getHttpProviderForChain(
  httpUrls: string[],
  options: GetProviderOptions = {},
): ethers.providers.JsonRpcProvider {
  const url =
    httpUrls.length > 0
      ? httpUrls[Math.floor(Math.random() * httpUrls.length)]
      : options.fallbackRpcUrl

  if (!url) {
    throw new Error('No HTTP RPC URL available and no fallback')
  }

  const network =
    options.chainId != null ? {chainId: options.chainId, name: 'unknown'} : undefined
  return new providers.JsonRpcProvider(url, network)
}

export interface WithRetryOptions extends GetProviderOptions {
  maxRetries?: number
  /** When true, log the HTTP RPC URL used for the request */
  logUrl?: boolean
}

/**
 * Run fn(provider); on failure, retry with a new random provider up to maxRetries times.
 */
export async function withHttpProviderRetry<T>(
  httpUrls: string[],
  fn: (provider: ethers.providers.JsonRpcProvider) => Promise<T>,
  options: WithRetryOptions = {},
): Promise<T> {
  const maxRetries = Math.max(1, options.maxRetries ?? 3)
  const fallback = options.fallbackRpcUrl
  const urls = httpUrls.length > 0 ? httpUrls : fallback ? [fallback] : []

  if (urls.length === 0) {
    throw new Error('No HTTP RPC URLs available for withHttpProviderRetry')
  }

  let lastError: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const provider = getHttpProviderForChain(urls, {
      fallbackRpcUrl: fallback,
      chainId: options.chainId,
    })
    if (options.logUrl) {
      const url = (provider as any).connection?.url ?? (provider as any).connection
      if (url) console.log(`🔗 HTTP RPC URL: ${url}`)
    }
    try {
      return await fn(provider)
    } catch (e) {
      lastError = e
      if (attempt < maxRetries - 1 && urls.length > 1) {
        // Next attempt will pick a different random URL
        continue
      }
      throw e
    }
  }
  throw lastError
}

/** Per-chain cache: create a new provider only when the cached one fails or doesn't respond. */
const providerCache = new Map<
  number,
  { provider: ethers.providers.JsonRpcProvider; url: string }
>()

/** Invalidate the cached HTTP provider for a chain. Next use will create a new provider (possibly different URL). Call when rate limited so the next run tries another endpoint. */
export function invalidateCachedProvider(chainId: number): void {
  providerCache.delete(chainId)
}

export interface WithCachedRetryOptions extends WithRetryOptions {
  /** When true, log when we create a new provider or invalidate cache */
  logCache?: boolean
}

/**
 * Run fn(provider) using a cached HTTP provider per chainId. A new provider is created only when:
 * - there is no cached provider for this chain, or
 * - the previous call with the cached provider failed (timeout, error, no response).
 * On failure we clear the cache for this chain and retry with a new provider (possibly different URL).
 */
export async function withCachedHttpProvider<T>(
  chainId: number,
  httpUrls: string[],
  fn: (provider: ethers.providers.JsonRpcProvider) => Promise<T>,
  options: WithCachedRetryOptions = {},
): Promise<T> {
  const maxRetries = Math.max(1, options.maxRetries ?? 3)
  const fallback = options.fallbackRpcUrl
  const urls = httpUrls.length > 0 ? httpUrls : fallback ? [fallback] : []
  const logCache = options.logCache === true

  if (urls.length === 0) {
    throw new Error('No HTTP RPC URLs available for withCachedHttpProvider')
  }

  let lastError: unknown
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let entry = providerCache.get(chainId)
    if (!entry) {
      const provider = getHttpProviderForChain(urls, {
        fallbackRpcUrl: fallback,
        chainId,
      })
      const url =
        (provider as any).connection?.url ?? (provider as any).connection ?? ''
      entry = { provider, url }
      providerCache.set(chainId, entry)
      if (logCache) console.log(`🔗 [cache] New HTTP provider for chain ${chainId}: ${url}`)
    }
    if (options.logUrl && !logCache) {
      if (entry.url) console.log(`🔗 HTTP RPC URL: ${entry.url}`)
    }
    try {
      const result = await fn(entry.provider)
      return result
    } catch (e) {
      lastError = e
      providerCache.delete(chainId)
      if (logCache) {
        console.warn(`🔗 [cache] Invalidated HTTP provider for chain ${chainId} after error:`, (e as Error)?.message ?? e)
      }
      if (attempt < maxRetries - 1) {
        continue
      }
      throw lastError
    }
  }
  throw lastError
}
