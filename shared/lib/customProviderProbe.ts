import { ethers } from 'ethers'
import { loadCustomProviderUrls, ResolvedProviderUrl } from './customProviders'
import { scrubUrls } from './rpcUrls'

export const DEFAULT_CUSTOM_PROVIDER_KEEPALIVE_MS = 24 * 60 * 60 * 1000

const PROBE_TIMEOUT_MS = 15_000
const LOG_PREFIX = '[customProviderKeepalive]'

export interface KeepaliveChain {
  chainId: number
  name: string
  urls: ResolvedProviderUrl[]
}

export interface ProbeResult {
  name: string
  url: string
  pass: boolean
  latencyMs: number
  blockNumber?: number
  error?: string
}

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

function destroyProvider(provider: ethers.providers.StaticJsonRpcProvider): void {
  provider.removeAllListeners()
  const maybeDestroy = provider as ethers.providers.JsonRpcProvider & { destroy?: () => void }
  maybeDestroy.destroy?.()
  ;(provider as { _websocket?: { close?: () => void } })._websocket?.close?.()
}

export async function probeCustomProviderUrl(
  entry: ResolvedProviderUrl,
  chainId: number,
): Promise<ProbeResult> {
  if (/YOUR_[A-Z_]+/.test(entry.url)) {
    return {
      name: entry.name,
      url: maskUrl(entry.url),
      pass: false,
      latencyMs: 0,
      error: 'placeholder value not replaced (YOUR_* detected) — add a real API key',
    }
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(entry.url, {
    chainId,
    name: 'unknown',
  })

  const start = Date.now()
  try {
    const block = await withTimeout(provider.getBlock('latest'), PROBE_TIMEOUT_MS)
    if (!block) {
      throw new Error('eth_getBlockByNumber returned null')
    }
    return {
      name: entry.name,
      url: entry.url,
      pass: true,
      latencyMs: Date.now() - start,
      blockNumber: block.number,
    }
  } catch (err) {
    return {
      name: entry.name,
      url: entry.url,
      pass: false,
      latencyMs: Date.now() - start,
      error: scrubUrls((err as Error)?.message ?? String(err)),
    }
  } finally {
    destroyProvider(provider)
  }
}

/**
 * Probes pre-resolved custom provider URLs and logs one line per provider.
 * Used by the runtime keepalive (URLs come from init, not a fresh JSON read).
 */
export async function probeResolvedUrls(
  urls: ResolvedProviderUrl[],
  chainId: number,
  chainName: string,
): Promise<{ passed: number; total: number }> {
  const probes = await Promise.all(urls.map((entry) => probeCustomProviderUrl(entry, chainId)))

  for (const r of probes) {
    const chainLabel = `${chainName} (${chainId})`
    if (r.pass) {
      console.log(
        `${LOG_PREFIX} ${chainLabel} provider ${r.name} alive: block ${r.blockNumber} (${r.latencyMs}ms)`,
      )
    } else {
      console.warn(
        `${LOG_PREFIX} ${chainLabel} provider ${r.name} failed: ${r.error ?? 'unknown error'}`,
      )
    }
  }

  const passed = probes.filter((r) => r.pass).length
  return { passed, total: probes.length }
}

export function startCustomProviderKeepalive(
  chains: KeepaliveChain[],
  intervalMs: number,
): void {
  const chainIds = chains.map((c) => c.chainId).join(',')
  console.log(`${LOG_PREFIX} started interval=${intervalMs}ms chains=${chainIds}`)

  async function tick(): Promise<void> {
    const urlCount = chains.reduce((sum, c) => sum + c.urls.length, 0)
    console.log(`${LOG_PREFIX} ${new Date().toISOString()} probing ${urlCount} custom provider URL(s)`)

    let passed = 0
    let total = 0
    for (const chain of chains) {
      const result = await probeResolvedUrls(chain.urls, chain.chainId, chain.name)
      passed += result.passed
      total += result.total
    }

    console.log(`${LOG_PREFIX} tick complete: ${passed}/${total} passed`)
  }

  tick().catch((err) => console.error(`${LOG_PREFIX} tick failed:`, err))

  setInterval(() => {
    tick().catch((err) => console.error(`${LOG_PREFIX} tick failed:`, err))
  }, intervalMs)
}

interface FailureSummary {
  chain: string
  name: string
  url: string
  error: string
}

/**
 * One-shot check for CLI use — loads provider JSON fresh per chain.
 */
export async function runCustomProviderCheck(
  chains: Array<{ chainId: number; name: string }>,
  options: { exitOnFailure?: boolean } = {},
): Promise<boolean> {
  const exitOnFailure = options.exitOnFailure ?? true
  const failures: FailureSummary[] = []

  for (const chain of chains) {
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

    console.log(`\n  Probing ${result.resolved.length} URL(s) with eth_getBlockByNumber...\n`)

    const probes = await Promise.all(
      result.resolved.map((entry) => probeCustomProviderUrl(entry, chain.chainId)),
    )

    for (const r of probes) {
      const status = r.pass ? '✓ PASS' : '✗ FAIL'
      const latency = `${r.latencyMs}ms`
      const display = maskUrl(r.url)
      const blockInfo = r.pass && r.blockNumber != null ? `  block ${r.blockNumber}` : ''
      console.log(
        `  ${pad(status, 7)}  ${pad(r.name, 12)}  ${pad(latency, 8)}  ${display}${blockInfo}`,
      )
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
    return true
  }

  console.error(`\nFailed providers (${failures.length}):`)
  for (const f of failures) {
    console.error(`\n  [${f.chain}] ${f.name}${f.url ? `  ${f.url}` : ''}`)
    console.error(`  error: ${f.error}`)
  }
  console.error('\nFix the entries above and re-run.')
  if (exitOnFailure) {
    process.exit(1)
  }
  return false
}
