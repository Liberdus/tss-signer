/**
 * check-custom-providers
 *
 * Loads providers-polygon.json and providers-bsc.json, builds the final URL
 * list for each chain, then fires a live eth_getBlockByNumber call against every
 * URL to confirm it is reachable and functional.
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

runProviderCheck(CHAINS).catch((err) => {
  console.error('[check-custom-providers] Unexpected error:', err)
  process.exit(1)
})
