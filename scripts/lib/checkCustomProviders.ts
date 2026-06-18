import { loadCustomProviderUrls } from '../../shared/lib/customProviders'
import { probeProviderUrl } from '../../shared/lib/providerHealthCheck'
import { redactRpcUrlForLog } from '../../shared/lib/redactForLog'

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
): Promise<void> {
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
