import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import * as rpcUrls from "./lib/rpcUrls";
import {
  invalidateCachedProvider,
  withCachedHttpProvider,
  WithCachedRetryOptions,
} from "./lib/httpProviderHelper";

// ---------------------------------------------------------------------------
// Chain configuration types
// ---------------------------------------------------------------------------

export interface ChainConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  contractAddress: string;
  tssSenderAddress?: string;
  bridgeAddress?: string;
  gasConfig?: { gasLimit: number; gasPriceTiers: number[] };
  deploymentBlock: number;
}

export interface ChainConfigs {
  supportedChains: Record<string, ChainConfig>;
  vaultChain?: ChainConfig;
  secondaryChainConfig?: ChainConfig;
  enableShardusCryptoAuth?: boolean;
  enableLiberdusNetwork: boolean;
  liberdusNetworkId: string;
  coordinatorUrl?: string;
  collectorHost?: string;
  proxyServerHost?: string;
}

// ---------------------------------------------------------------------------
// Load config files (synchronous at module level — fail fast if missing)
// ---------------------------------------------------------------------------

export const chainConfigsRaw: ChainConfigs = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../chain-config.json"), "utf8"),
);

// All chains except vaultChain must have tssSenderAddress, bridgeAddress, and gasConfig
function requireFullChainConfig(config: ChainConfig, label: string): void {
  if (!config.tssSenderAddress || !config.bridgeAddress || !config.gasConfig) {
    console.error(
      `[config] ${label} (chainId ${config.chainId}) is missing tssSenderAddress, bridgeAddress, or gasConfig`
    );
    process.exit(1);
  }
}
if (chainConfigsRaw.enableLiberdusNetwork) {
  for (const [chainId, config] of Object.entries(chainConfigsRaw.supportedChains)) {
    requireFullChainConfig(config, `supportedChains[${chainId}]`);
  }
} else {
  if (!chainConfigsRaw.vaultChain) {
    console.error("[config] vaultChain is required when enableLiberdusNetwork is false");
    process.exit(1);
  }
  if (!chainConfigsRaw.secondaryChainConfig) {
    console.error("[config] secondaryChainConfig is required when enableLiberdusNetwork is false");
    process.exit(1);
  }
  requireFullChainConfig(chainConfigsRaw.secondaryChainConfig, "secondaryChainConfig");
}

const chainsToMonitor: ChainConfig[] = chainConfigsRaw.enableLiberdusNetwork
  ? Object.values(chainConfigsRaw.supportedChains)
  : [chainConfigsRaw.vaultChain!, chainConfigsRaw.secondaryChainConfig!];

export const monitoredChainIds = chainsToMonitor.map((config) => config.chainId);

const rpcConfigByChainId: Record<string, { rpcUrl: string }> = {};
const fallbackRpcUrlByChainId = new Map<number, string>();
for (const config of chainsToMonitor) {
  rpcConfigByChainId[config.chainId.toString()] = { rpcUrl: config.rpcUrl };
  const fallbackRpcUrl = config.rpcUrl;
  fallbackRpcUrlByChainId.set(config.chainId, fallbackRpcUrl);
}
rpcUrls.initFromConfig(rpcConfigByChainId);
rpcUrls.startHourlyChainlistFetch(monitoredChainIds);

export function getHttpRpcUrlsForChain(chainId: number): string[] {
  return rpcUrls.getHttpUrls(chainId);
}

function getFallbackRpcUrl(chainId: number): string | undefined {
  return fallbackRpcUrlByChainId.get(chainId);
}

export function hasChainHttpProviderConfig(chainId: number): boolean {
  return getHttpRpcUrlsForChain(chainId).length > 0 || !!getFallbackRpcUrl(chainId);
}

export function invalidateChainHttpProvider(chainId: number): void {
  invalidateCachedProvider(chainId);
}

export async function withChainHttpProvider<T>(
  chainId: number,
  fn: (provider: ethers.providers.JsonRpcProvider) => Promise<T>,
  options: Omit<WithCachedRetryOptions, "fallbackRpcUrl"> = {}
): Promise<T> {
  return withCachedHttpProvider(chainId, getHttpRpcUrlsForChain(chainId), fn, {
    ...options,
    fallbackRpcUrl: getFallbackRpcUrl(chainId),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getChainConfigById(chainId: number): ChainConfig | undefined {
  // In Liberdus mode, supportedChains is the canonical source — its contract
  // addresses differ from vaultChain/secondaryChainConfig, so check it first.
  if (chainConfigsRaw.enableLiberdusNetwork) {
    return chainConfigsRaw.supportedChains[chainId.toString()];
  }
  // Vault mode: vaultChain and secondaryChainConfig are the active configs.
  if (chainConfigsRaw.vaultChain?.chainId === chainId)
    return chainConfigsRaw.vaultChain;
  if (chainConfigsRaw.secondaryChainConfig?.chainId === chainId)
    return chainConfigsRaw.secondaryChainConfig;
  return chainConfigsRaw.supportedChains[chainId.toString()];
}
