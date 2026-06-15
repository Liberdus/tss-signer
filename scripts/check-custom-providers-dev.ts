/**
 * check-custom-providers-dev
 *
 * Same as check-custom-providers but targets testnet chains:
 *   - Polygon Amoy Testnet (chainId 80002)
 *   - BSC Testnet / Chapel (chainId 97)
 *
 * Usage:
 *   npm run check-custom-providers:dev
 *
 * Exit code: 0 if all URLs pass, 1 if any fail.
 */

import { runProviderCheck } from './lib/checkCustomProviders'

const CHAINS = [
  { chainId: 80002, name: 'Polygon Amoy Testnet' },
  { chainId: 97,    name: 'BSC Testnet' },
]

runProviderCheck(CHAINS).catch((err) => {
  console.error('[check-custom-providers-dev] Unexpected error:', err)
  process.exit(1)
})
