import { ethers } from "ethers";
import fs from "fs";
import path from "path";

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
  fs.readFileSync(path.join(__dirname, "../../chain-config.json"), "utf8")
);

export const infuraKey: string = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../infura_keys.json"), "utf8")
  ) as string[]
)[0];

// ---------------------------------------------------------------------------
// HTTP providers (one per monitored chain, no WebSocket needed)
// ---------------------------------------------------------------------------

export const chainProviders = new Map<
  number,
  ethers.providers.JsonRpcProvider
>();

const chainsToMonitor: ChainConfig[] = chainConfigsRaw.enableLiberdusNetwork
  ? Object.values(chainConfigsRaw.supportedChains)
  : [chainConfigsRaw.vaultChain!, chainConfigsRaw.secondaryChainConfig!];

for (const config of chainsToMonitor) {
  const rpcUrl = config.rpcUrl.includes("infura.io")
    ? `${config.rpcUrl}${infuraKey}`
    : config.rpcUrl;
  chainProviders.set(
    config.chainId,
    new ethers.providers.JsonRpcProvider(rpcUrl)
  );
  console.log(
    `HTTP provider initialized for ${config.name} (Chain ID: ${config.chainId})`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getChainConfigById(chainId: number): ChainConfig | undefined {
  if (chainConfigsRaw.vaultChain?.chainId === chainId)
    return chainConfigsRaw.vaultChain;
  if (chainConfigsRaw.secondaryChainConfig?.chainId === chainId)
    return chainConfigsRaw.secondaryChainConfig;
  return chainConfigsRaw.supportedChains[chainId.toString()];
}
