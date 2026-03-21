import {ChainConfig} from './config'
import {ethers} from 'ethers'
import * as rpcUrls from './lib/rpcUrls'
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
  options: {} = {},
): InitializedRpcConfig {
  const chainIds = chains.map((config) => config.chainId)
  const rpcConfigByChainId: Record<string, {rpcUrl: string}> = {}
  const fallbackRpcUrlByChainId = new Map<number, string>()

  for (const config of chains) {
    rpcConfigByChainId[config.chainId.toString()] = {rpcUrl: config.rpcUrl}
    fallbackRpcUrlByChainId.set(config.chainId, config.rpcUrl)
  }

  rpcUrls.initFromConfig(rpcConfigByChainId)
  rpcUrls.startHourlyChainlistFetch(chainIds)

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
