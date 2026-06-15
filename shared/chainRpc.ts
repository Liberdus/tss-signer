import {ChainConfig} from './config'
import {ethers} from 'ethers'
import * as rpcUrls from './lib/rpcUrls'
import {loadCustomProviderUrls} from './lib/customProviders'
import {
  DEFAULT_CUSTOM_PROVIDER_KEEPALIVE_MS,
  KeepaliveChain,
  startCustomProviderKeepalive,
} from './lib/customProviderProbe'
import {
  getHttpProviderForChain,
  invalidateCachedProvider,
  withCachedHttpProvider,
  WithCachedRetryOptions,
} from './lib/httpProviderHelper'

export interface InitializedRpcConfig {
  chainIds: number[]
  getHttpRpcUrlsForChain: (chainId: number) => string[]
  getFallbackRpcUrl: (chainId: number) => string | undefined
  hasChainHttpProviderConfig: (chainId: number) => boolean
  invalidateChainHttpProvider: (chainId: number) => void
  withChainHttpProvider: <T>(
    chainId: number,
    fn: (provider: ethers.providers.JsonRpcProvider) => Promise<T>,
    options?: Omit<WithCachedRetryOptions, 'fallbackRpcUrl'>,
  ) => Promise<T>
}

export function buildChainProviderMap<T>(
  chains: ChainConfig[],
  rpcConfig: InitializedRpcConfig,
  buildEntry: (config: ChainConfig, provider: ethers.providers.JsonRpcProvider) => T,
): Map<number, T> {
  const entries = new Map<number, T>()

  for (const config of chains) {
    const provider = getHttpProviderForChain(rpcConfig.getHttpRpcUrlsForChain(config.chainId), {
      fallbackRpcUrl: rpcConfig.getFallbackRpcUrl(config.chainId),
      chainId: config.chainId,
    })

    entries.set(config.chainId, buildEntry(config, provider))
  }

  return entries
}

export function initializeChainRpcConfig(
  chains: ChainConfig[],
  options: {
    rpcProviderMode?: 'custom' | 'chainlist' | 'both'
    customProviderKeepaliveIntervalMs?: number
  } = {},
): InitializedRpcConfig {
  const chainIds = chains.map((config) => config.chainId)
  const rpcConfigByChainId: Record<string, {rpcUrl: string}> = {}
  const fallbackRpcUrlByChainId = new Map<number, string>()

  const mode = options.rpcProviderMode ?? 'both'
  if (mode !== 'custom' && mode !== 'chainlist' && mode !== 'both') {
    throw new Error(`[chainRpc] Invalid rpcProviderMode: "${mode}". Expected "custom", "chainlist", or "both"`)
  }

  for (const config of chains) {
    rpcConfigByChainId[config.chainId.toString()] = {rpcUrl: config.rpcUrl}
    if (mode !== 'custom') {
      fallbackRpcUrlByChainId.set(config.chainId, config.rpcUrl)
    }
  }

  if (mode !== 'custom') {
    rpcUrls.initFromConfig(rpcConfigByChainId)
  }

  const keepaliveChains: KeepaliveChain[] = []

  if (mode === 'custom' || mode === 'both') {
    for (const config of chains) {
      try {
        const result = loadCustomProviderUrls(config.chainId)
        const urls = result.resolved.map((r) => r.url)
        if (urls.length > 0) {
          rpcUrls.addHttpUrls(config.chainId, urls, {prepend: true, providerNames: result.resolved.map((r) => r.name)})
          const providerNames = [...new Set(result.resolved.map((r) => r.name))].join(', ')
          console.log(`[chainRpc] Loaded ${urls.length} custom provider URL(s) for chainId ${config.chainId} (${providerNames})`)
          keepaliveChains.push({
            chainId: config.chainId,
            name: config.name,
            urls: result.resolved,
          })
        }
      } catch (err) {
        if (mode === 'custom') {
          throw err
        }
        console.warn(`[chainRpc] Custom providers unavailable for chainId ${config.chainId} — falling back to Chainlist: ${(err as Error).message}`)
      }
    }
  }

  const keepaliveIntervalMs =
    options.customProviderKeepaliveIntervalMs ?? DEFAULT_CUSTOM_PROVIDER_KEEPALIVE_MS
  if (keepaliveChains.length > 0 && keepaliveIntervalMs > 0) {
    startCustomProviderKeepalive(keepaliveChains, keepaliveIntervalMs)
  }

  if (mode === 'chainlist' || mode === 'both') {
    rpcUrls.startHourlyChainlistFetch(chainIds)
  }

  function getHttpRpcUrlsForChain(chainId: number): string[] {
    return rpcUrls.getHttpUrls(chainId)
  }

  function getFallbackRpcUrl(chainId: number): string | undefined {
    return fallbackRpcUrlByChainId.get(chainId)
  }

  function hasChainHttpProviderConfig(chainId: number): boolean {
    return getHttpRpcUrlsForChain(chainId).length > 0 || !!getFallbackRpcUrl(chainId)
  }

  function invalidateChainHttpProvider(chainId: number): void {
    invalidateCachedProvider(chainId)
  }

  async function withChainHttpProvider<T>(
    chainId: number,
    fn: (provider: ethers.providers.JsonRpcProvider) => Promise<T>,
    providerOptions: Omit<WithCachedRetryOptions, 'fallbackRpcUrl'> = {},
  ): Promise<T> {
    return withCachedHttpProvider(chainId, getHttpRpcUrlsForChain(chainId), fn, {
      // Default HTTP RPC timeout. Callers can still override this per request when needed.
      timeoutMs: 10_000,
      ...providerOptions,
      fallbackRpcUrl: getFallbackRpcUrl(chainId),
    })
  }

  return {
    chainIds,
    getHttpRpcUrlsForChain,
    getFallbackRpcUrl,
    hasChainHttpProviderConfig,
    invalidateChainHttpProvider,
    withChainHttpProvider,
  }
}
