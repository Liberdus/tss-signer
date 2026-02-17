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
