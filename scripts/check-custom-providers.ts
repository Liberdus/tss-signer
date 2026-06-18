/**
 * check-custom-providers
 *
 * Loads keystores/bnbtss/providers-polygon.json and providers-bsc.json,
 * builds the final URL list for each chain, then probes every URL with a raw
 * HTTP JSON-RPC eth_blockNumber POST (shared probeProviderUrl / axios — not
 * ethers JsonRpcProvider).
 *
 * Usage:
 *   npm run check-custom-providers:mainnet
 *
 * Exit code: 0 if all URLs pass, 1 if any fail.
 */

import { runProviderCheck } from './lib/checkCustomProviders'

const CHAINS = [
  { chainId: 137, name: 'Polygon Mainnet' },
  { chainId: 56,  name: 'BSC Mainnet' },
]

runProviderCheck(CHAINS, 'check-custom-providers').catch((err) => {
  console.error('[check-custom-providers] Unexpected error:', err)
  process.exit(1)
})
