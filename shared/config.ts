import fs from 'fs'
import {ethers} from 'ethers'
import {resolveRepoConfigPath} from './utils/paths'

export interface ChainConfig {
  name: string
  chainId: number
  rpcUrl: string
  contractAddress: string
  tssSenderAddress: string
  gasConfig?: {gasLimit: number; gasPriceTiers: number[]}
  deploymentBlock: number
}

export type VaultChainConfig = Omit<ChainConfig, 'tssSenderAddress'>

export function isSigningChainConfig(config: ChainConfig | VaultChainConfig): config is ChainConfig {
  return 'tssSenderAddress' in config
}

export function requireSigningChainConfig(
  chainConfigs: ChainConfigs,
  chainId: number,
): ChainConfig {
  const config = getChainConfigById(chainConfigs, chainId)
  if (!config || !isSigningChainConfig(config)) {
    throw new Error(`[config] chainId ${chainId} is not a signing chain`)
  }
  return config
}

export interface LiberdusBridgeGuards {
  maxBridgeInAmount: string       // LIB amount — operator-imposed max for BRIDGE_IN txs (Liberdus → EVM); "0" disables the limit
  minBridgeOutAmount: string      // LIB amount — operator-imposed min for BRIDGE_OUT txs (EVM → Liberdus); "0" disables the limit
  maxBridgeOutAmount: string      // LIB amount — operator-imposed max for BRIDGE_OUT txs (EVM → Liberdus); "0" disables the limit
  requirePublicRecipientAccount: boolean // When true, refunds BRIDGE_OUT txs whose Liberdus recipient account does not exist or is private
}


export interface ChainConfigs {
  supportedChains: Record<string, ChainConfig>
  vaultChain?: VaultChainConfig
  secondaryChainConfig?: ChainConfig
  isRemote?: boolean
  enableLiberdusNetwork: boolean
  /**
   * Controls which RPC sources are used for each chain.
   *   "custom"    — only URLs from keystores/bnbtss/providers-*.json (no Chainlist fetch)
   *   "chainlist" — only Chainlist (hourly fetch); custom provider files ignored
   *   "both"      — custom URLs prepended, Chainlist fetched hourly (default)
   */
  rpcProviderMode?: 'custom' | 'chainlist' | 'both'
  /**
   * Hours between custom provider health checks (eth_blockNumber). Default 24 when omitted.
   */
  providerHealthCheckIntervalHours?: number
  liberdusNetworkId: string
  collectorHost?: string
  proxyServerHost?: string
  liberdusBridgeGuards: LiberdusBridgeGuards
  /**
   * Observer-only local development option. When true, startup skips historical
   * sync for both EVM and Liberdus monitors: EVM cursors are seeded to current
   * chain tips and Liberdus cursors are seeded to the current wall-clock time.
   */
  observerSkipOldData?: boolean
  /**
   * Observer-only Liberdus option. Applies only to Liberdus transactions, and
   * only when a per-chain Liberdus cursor has not been initialized yet (missing
   * or 0). When true, seeds that cursor to the current wall-clock time instead
   * of scanning from timestamp 0.
   */
  observerSkipOldLiberdusData?: boolean
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
  if (!config.tssSenderAddress || !config.gasConfig) {
    throw new Error(
      `[config] ${label} (chainId ${config.chainId}) is missing tssSenderAddress or gasConfig`,
    )
  }
}

export function parseBooleanOption(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function validateBridgeGuardAmount(value: unknown, fieldName: keyof LiberdusBridgeGuards): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`[config] liberdusBridgeGuards.${fieldName} must be a non-empty LIB amount string; use "0" to disable`)
  }
  try {
    const parsed = ethers.utils.parseEther(value)
    if (parsed.lt(0)) {
      throw new Error('amount must be non-negative')
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(`[config] liberdusBridgeGuards.${fieldName} is invalid: ${reason}`)
  }
  return value
}

function validateLiberdusBridgeGuards(chainConfigs: ChainConfigs): void {
  const guards = chainConfigs.liberdusBridgeGuards
  if (!guards || typeof guards !== 'object') {
    throw new Error('[config] liberdusBridgeGuards is required')
  }
  validateBridgeGuardAmount(guards.maxBridgeInAmount, 'maxBridgeInAmount')
  validateBridgeGuardAmount(guards.minBridgeOutAmount, 'minBridgeOutAmount')
  validateBridgeGuardAmount(guards.maxBridgeOutAmount, 'maxBridgeOutAmount')
  if (typeof guards.requirePublicRecipientAccount !== 'boolean') {
    throw new Error('[config] liberdusBridgeGuards.requirePublicRecipientAccount must be a boolean')
  }
}

export function validateChainConfigs(chainConfigs: ChainConfigs): ChainConfigs {
  validateLiberdusBridgeGuards(chainConfigs)

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
    : [chainConfigs.vaultChain! as ChainConfig, chainConfigs.secondaryChainConfig!]
}

export function getEffectiveChainIds(chainConfigs: ChainConfigs = chainConfigsRaw): number[] {
  if (chainConfigs.enableLiberdusNetwork) {
    return Object.keys(chainConfigs.supportedChains).map(Number)
  }
  return [chainConfigs.secondaryChainConfig!.chainId]
}

export function getChainConfigById(chainConfigs: ChainConfigs, chainId: number): ChainConfig | VaultChainConfig | undefined {
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
