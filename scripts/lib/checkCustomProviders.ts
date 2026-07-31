import {
  loadCustomProviderUrls,
  ProviderLoadResult,
} from '../../shared/lib/customProviders'
import {
  probeProviderUrl,
  ProbeProviderUrlFn,
} from '../../shared/lib/providerHealthCheck'
import { redactRpcUrlForLog } from '../../shared/lib/redactForLog'

export const DEFAULT_PROVIDER_PROBE_FN: ProbeProviderUrlFn = probeProviderUrl

export type LoadCustomProviderUrlsFn = typeof loadCustomProviderUrls

export interface RunProviderCheckOptions {
  probeFn?: ProbeProviderUrlFn
  loadUrls?: LoadCustomProviderUrlsFn
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface FailureSummary {
  chain: string
  name: string
  url: string
  error: string
}

export async function runProviderCheck(
  chains: Array<{ chainId: number; name: string }>,
  scriptName: string,
  options: RunProviderCheckOptions = {},
): Promise<void> {
  const probeFn = options.probeFn ?? DEFAULT_PROVIDER_PROBE_FN
  const loadUrls = options.loadUrls ?? loadCustomProviderUrls
  const failures: FailureSummary[] = []

  console.log(
    `[${scriptName}] Probing via separate HTTP JSON-RPC eth_blockNumber and eth_chainId calls (axios POST; not ethers JsonRpcProvider)`,
  )

  for (const chain of chains) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`Chain: ${chain.name} (chainId ${chain.chainId})`)
    console.log(`${'─'.repeat(60)}`)

    let result: ProviderLoadResult
    try {
      result = loadUrls(chain.chainId)
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

    console.log(
      `\n  Probing ${result.resolved.length} URL(s) via separate HTTP JSON-RPC calls...\n`,
    )

    const probes = await Promise.all(
      result.resolved.map((entry) => probeFn(entry, chain.chainId)),
    )

    for (const r of probes) {
      const status = r.pass ? '✓ PASS' : '✗ FAIL'
      const latency = `${r.latencyMs}ms`
      const block = r.blockNumber != null ? `  block=${r.blockNumber}` : ''
      const display = redactRpcUrlForLog(r.url)
      console.log(`  ${pad(status, 7)}  ${pad(r.name, 12)}  ${pad(latency, 8)}${block}  ${display}`)
      if (!r.pass) {
        failures.push({
          chain: chain.name,
          name: r.name,
          url: redactRpcUrlForLog(r.url),
          error: r.error ?? '',
        })
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
