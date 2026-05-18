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

import { ethers } from 'ethers'
import { loadCustomProviderUrls, ResolvedProviderUrl } from '../shared/lib/customProviders'

const CHAINS: Array<{ chainId: number; name: string }> = [
  { chainId: 80002, name: 'Polygon Amoy Testnet' },
  { chainId: 97,    name: 'BSC Testnet' },
]

const PROBE_TIMEOUT_MS = 15_000

function maskUrl(url: string): string {
  try {
    const u = new URL(url)
    const pathParts = u.pathname.split('/')
    if (pathParts.length > 1) {
      const last = pathParts[pathParts.length - 1]
      if (last.length > 6) {
        pathParts[pathParts.length - 1] = last.slice(0, 4) + '****'
      }
    }
    u.pathname = pathParts.join('/')
    u.search = u.search ? '?****' : ''
    return u.toString()
  } catch {
    return url.slice(0, 40) + '...'
  }
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length)
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let handle: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(handle!)
  }
}

interface ProbeResult {
  name: string
  url: string
  pass: boolean
  latencyMs: number
  error?: string
}

async function probeUrl(entry: ResolvedProviderUrl, chainId: number): Promise<ProbeResult> {
  const provider = new ethers.providers.StaticJsonRpcProvider(entry.url, {
    chainId,
    name: 'unknown',
  })
  const start = Date.now()
  try {
    await withTimeout(provider.getBlockNumber(), PROBE_TIMEOUT_MS)
    return { name: entry.name, url: entry.url, pass: true, latencyMs: Date.now() - start }
  } catch (err) {
    return {
      name: entry.name,
      url: entry.url,
      pass: false,
      latencyMs: Date.now() - start,
      error: (err as Error)?.message ?? String(err),
    }
  } finally {
    provider.removeAllListeners()
    ;(provider as any)._websocket?.close?.()
  }
}

interface FailureSummary {
  chain: string
  name: string
  url: string
  error: string
}

async function main(): Promise<void> {
  const failures: FailureSummary[] = []

  for (const chain of CHAINS) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`Chain: ${chain.name} (chainId ${chain.chainId})`)
    console.log('─'.repeat(60))

    let result: ReturnType<typeof loadCustomProviderUrls>
    try {
      result = loadCustomProviderUrls(chain.chainId)
    } catch (err) {
      const msg = (err as Error).message
      console.error(`  ERROR loading providers: ${msg}`)
      failures.push({ chain: chain.name, name: '(config)', url: '', error: msg })
      continue
    }

    if (result.skipped.length > 0) {
      console.log(`  Skipped entries (${result.skipped.length}):`)
      for (const s of result.skipped) {
        console.log(`    - ${pad(s.name, 12)}  reason: ${s.reason}`)
      }
    }

    console.log(`\n  Probing ${result.resolved.length} URL(s) with eth_blockNumber...\n`)

    const probes = await Promise.all(
      result.resolved.map((entry) => probeUrl(entry, chain.chainId)),
    )

    for (const r of probes) {
      const status = r.pass ? '✓ PASS' : '✗ FAIL'
      const latency = `${r.latencyMs}ms`
      const display = maskUrl(r.url)
      console.log(`  ${pad(status, 7)}  ${pad(r.name, 12)}  ${pad(latency, 8)}  ${display}`)
      if (!r.pass) {
        failures.push({ chain: chain.name, name: r.name, url: maskUrl(r.url), error: r.error ?? '' })
      }
    }

    const passed = probes.filter((r) => r.pass).length
    console.log(`\n  Result: ${passed}/${probes.length} passed`)
  }

  console.log(`\n${'─'.repeat(60)}`)

  if (failures.length === 0) {
    console.log('\nAll providers passed.')
    return
  }

  console.error(`\nFailed providers (${failures.length}):`)
  for (const f of failures) {
    console.error(`\n  [${f.chain}] ${f.name}${f.url ? `  ${f.url}` : ''}`)
    console.error(`  error: ${f.error}`)
  }
  console.error('\nFix the entries above and re-run.')
  process.exit(1)
}

main().catch((err) => {
  console.error('[check-custom-providers-dev] Unexpected error:', err)
  process.exit(1)
})
