import fs from 'fs'
import {resolveRepoConfigPath} from './utils/paths'

export interface ChainConfig {
  name: string
  chainId: number
  rpcUrl: string
  contractAddress: string
  tssSenderAddress?: string
  bridgeAddress?: string
  gasConfig?: {gasLimit: number; gasPriceTiers: number[]}
  deploymentBlock: number
}

export interface LiberdusGuards {
  maxBridgeInAmount?: string   // Wei string — operator-imposed max for BRIDGE_IN txs
  maxBridgeOutAmount?: string  // Wei string — operator-imposed max for BRIDGE_OUT txs
}

export interface ChainGuards {
  maxBridgeInAmount?: string   // Wei string — operator-imposed max for BRIDGE_IN txs
  maxBridgeOutAmount?: string  // Wei string — operator-imposed max for BRIDGE_OUT txs
}

export interface ChainConfigs {
  supportedChains: Record<string, ChainConfig>
  vaultChain?: ChainConfig
  secondaryChainConfig?: ChainConfig
  enableLiberdusNetwork: boolean
  /**
   * When true, the observer prefers Infura-based RPC URLs (when supported for the
   * configured chainId). Disabled by default; requires Infura API keys via env.
   */
  useInfuraRpcProviders?: boolean
  liberdusNetworkId: string
  collectorHost?: string
  proxyServerHost?: string
  liberdusGuards?: LiberdusGuards
  chainGuards?: Record<string, ChainGuards>  // keyed by chainId as string
}

export interface ParamsConfig {
  parties: number
  threshold: number
}

export function resolveChainConfigPath(fromDir = __dirname): string {
  return resolveRepoConfigPath('chain-config.json', fromDir)
}

export function loadChainConfigs(fromDir = __dirname): ChainConfigs {
  return JSON.parse(fs.readFileSync(resolveChainConfigPath(fromDir), 'utf8')) as ChainConfigs
}

export function resolveParamsPath(fromDir = __dirname): string {
  return resolveRepoConfigPath('params.json', fromDir)
}

export function loadParamsConfig(fromDir = __dirname): ParamsConfig {
  return JSON.parse(fs.readFileSync(resolveParamsPath(fromDir), 'utf8')) as ParamsConfig
}

export function requireFullChainConfig(config: ChainConfig, label: string): void {
  if (!config.tssSenderAddress || !config.bridgeAddress || !config.gasConfig) {
    throw new Error(
      `[config] ${label} (chainId ${config.chainId}) is missing tssSenderAddress, bridgeAddress, or gasConfig`,
    )
  }
}

export function validateChainConfigs(chainConfigs: ChainConfigs): ChainConfigs {
  if (chainConfigs.enableLiberdusNetwork) {
    for (const [chainId, config] of Object.entries(chainConfigs.supportedChains)) {
      requireFullChainConfig(config, `supportedChains[${chainId}]`)
    }
    return chainConfigs
  }

  if (!chainConfigs.vaultChain) {
    throw new Error('[config] vaultChain is required when enableLiberdusNetwork is false')
  }
  if (!chainConfigs.secondaryChainConfig) {
    throw new Error('[config] secondaryChainConfig is required when enableLiberdusNetwork is false')
  }
  if (chainConfigs.vaultChain.chainId === chainConfigs.secondaryChainConfig.chainId) {
    throw new Error('[config] vaultChain and secondaryChainConfig must have different chainIds')
  }

  requireFullChainConfig(chainConfigs.secondaryChainConfig, 'secondaryChainConfig')
  return chainConfigs
}

export function getConfiguredChains(chainConfigs: ChainConfigs): ChainConfig[] {
  return chainConfigs.enableLiberdusNetwork
    ? Object.values(chainConfigs.supportedChains)
    : [chainConfigs.vaultChain!, chainConfigs.secondaryChainConfig!]
}

export function getEffectiveChainIds(chainConfigs: ChainConfigs = chainConfigsRaw): number[] {
  if (chainConfigs.enableLiberdusNetwork) {
    return Object.keys(chainConfigs.supportedChains).map(Number)
  }
  return [chainConfigs.secondaryChainConfig!.chainId]
}

export function getChainConfigById(chainConfigs: ChainConfigs, chainId: number): ChainConfig | undefined {
  if (chainConfigs.enableLiberdusNetwork) {
    return chainConfigs.supportedChains[chainId.toString()]
  }
  if (chainConfigs.vaultChain?.chainId === chainId) return chainConfigs.vaultChain
  if (chainConfigs.secondaryChainConfig?.chainId === chainId) return chainConfigs.secondaryChainConfig
  return chainConfigs.supportedChains[chainId.toString()]
}

/**
 * Maps a configured chainId to the actual network chainId for transaction
 * signing. In local development the secondary contract may be deployed with
 * chainId 31338, but the Hardhat network itself reports 31337.
 */
export function toNetworkChainId(chainId: number): number {
  return chainId === 31338 ? 31337 : chainId
}

export const chainConfigsRaw = validateChainConfigs(loadChainConfigs())
export const paramsConfigRaw = loadParamsConfig()
