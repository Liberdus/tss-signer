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
  wsUrl: string;
  contractAddress: string;
  tssSenderAddress: string;
  bridgeAddress: string;
  gasConfig: { gasLimit: number; gasPriceTiers: number[] };
  deploymentBlock?: number;
}

export interface ChainConfigs {
  supportedChains: Record<string, ChainConfig>;
  vaultChain?: ChainConfig;
  secondaryChainConfig?: ChainConfig;
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

export const infuraKey: string = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../infura_keys.json"), "utf8"),
  ) as string[]
)[0];

const chainsToMonitor: ChainConfig[] = chainConfigsRaw.enableLiberdusNetwork
  ? Object.values(chainConfigsRaw.supportedChains)
  : [chainConfigsRaw.vaultChain!, chainConfigsRaw.secondaryChainConfig!];

export const monitoredChainIds = chainsToMonitor.map((config) => config.chainId);

const rpcConfigByChainId: Record<string, { rpcUrl: string }> = {};
const fallbackRpcUrlByChainId = new Map<number, string>();
for (const config of chainsToMonitor) {
  rpcConfigByChainId[config.chainId.toString()] = { rpcUrl: config.rpcUrl };
  const fallbackRpcUrl = config.rpcUrl.includes("infura.io")
    ? `${config.rpcUrl}${infuraKey}`
    : config.rpcUrl;
  fallbackRpcUrlByChainId.set(config.chainId, fallbackRpcUrl);
}
rpcUrls.initFromConfig(rpcConfigByChainId, infuraKey);
rpcUrls.startHourlyChainlistFetch(monitoredChainIds, infuraKey);

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
