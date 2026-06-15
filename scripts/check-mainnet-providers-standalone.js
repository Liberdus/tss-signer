#!/usr/bin/env node
/**
 * Standalone mainnet RPC provider checker.
 *
 * Copy this file into any folder that contains both:
 *   - providers-polygon.json
 *   - providers-bsc.json
 *
 * Then run:
 *   node check-mainnet-providers-standalone.js
 *
 * Requires Node.js 18+ (native fetch).
 * Exit code: 0 if all URLs pass, 1 if any fail.
 */

'use strict'

const fs = require('fs')
const path = require('path')

const PROBE_TIMEOUT_MS = 15_000

const CHAINS = [
  { chainId: 137, file: 'providers-polygon.json', name: 'Polygon Mainnet' },
  { chainId: 56, file: 'providers-bsc.json', name: 'BSC Mainnet' },
]

const PROVIDER_REGISTRY = {
  alchemy: {
    templates: {
      137: 'https://polygon-mainnet.g.alchemy.com/v2/{key}',
      56: 'https://bnb-mainnet.g.alchemy.com/v2/{key}',
    },
  },
  infura: {
    templates: {
      137: 'https://polygon-mainnet.infura.io/v3/{key}',
      56: 'https://bsc-mainnet.infura.io/v3/{key}',
    },
  },
  drpc: {
    templates: {
      137: 'https://lb.drpc.live/polygon/{key}',
      56: 'https://lb.drpc.live/bsc/{key}',
    },
  },
  getblock: {
    templates: {
      137: 'https://go.getblock.us/{key}',
      56: 'https://shared.us-east-1.getblock.io/{key}',
    },
  },
  moralis: {
    templates: {
      137: 'https://site1.moralis-nodes.com/polygon/{key}',
      56: 'https://site1.moralis-nodes.com/bsc/{key}',
    },
  },
  ankr: {
    templates: {
      137: 'https://rpc.ankr.com/polygon/{key}',
      56: 'https://rpc.ankr.com/bsc/{key}',
    },
  },
  rpcfast: {
    templates: {
      137: 'https://polygon-mainnet.rpcfast.com?api_key={key}',
      56: 'https://bsc-mainnet.rpcfast.com?api_key={key}',
    },
  },
  onfinality: {
    templates: {
      137: 'https://polygon.api.onfinality.io/rpc?apikey={key}',
      56: 'https://bnb.api.onfinality.io/rpc?apikey={key}',
    },
  },
  tenderly: {
    templates: {
      137: 'https://polygon.gateway.tenderly.co/{key}',
    },
  },
  quicknode: { urlOnly: true },
}

function pad(s, len) {
  return s.length >= len ? s : s + ' '.repeat(len - s.length)
}

function maskUrl(url) {
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

function scrubUrls(text) {
  return String(text).replace(/https?:\/\/\S+/g, (match) => maskUrl(match))
}

function buildUrlFromTemplate(name, chainId, apiKey) {
  const template = PROVIDER_REGISTRY[name.toLowerCase()]?.templates?.[chainId]
  if (!template) return undefined
  return template.replace('{key}', apiKey.trim())
}

function loadCustomProviderFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Provider config not found: ${filePath}`)
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    throw new Error(`Failed to parse ${filePath}: ${e.message}`)
  }
  if (typeof raw.chainId !== 'number') {
    throw new Error(`${filePath}: "chainId" must be a number`)
  }
  if (!Array.isArray(raw.providers)) {
    throw new Error(`${filePath}: "providers" must be an array`)
  }
  return raw
}

function buildUrlsFromProviderConfig(config) {
  const resolved = []
  const skipped = []

  for (const entry of config.providers) {
    const name = (entry.name || '').trim()
    if (!name) {
      skipped.push({ name: '(unnamed)', reason: 'missing name field' })
      continue
    }

    const keys = (entry.keys ?? []).map((k) => (k || '').trim()).filter(Boolean)
    if (keys.length === 0) {
      console.warn(
        `[customProviders] Provider "${name}" has no keys — skipping. Add at least one URL or API key to enable it.`,
      )
      skipped.push({ name, reason: 'keys is empty' })
      continue
    }

    const isUrlOnly = PROVIDER_REGISTRY[name.toLowerCase()]?.urlOnly === true

    for (const key of keys) {
      const isUrl = key.startsWith('https://') || key.startsWith('http://')

      if (isUrlOnly) {
        if (!isUrl) {
          skipped.push({
            name,
            reason: `"${name}" requires a full https:// URL — a bare API key cannot be used for this provider`,
          })
          continue
        }
        resolved.push({ name, url: key })
        continue
      }

      if (isUrl) {
        resolved.push({ name, url: key })
        continue
      }

      const constructed = buildUrlFromTemplate(name, config.chainId, key)
      if (!constructed) {
        skipped.push({
          name,
          reason: `no URL template known for "${name}" on chainId ${config.chainId} — provide a full https:// URL instead`,
        })
        continue
      }
      resolved.push({ name, url: constructed })
    }
  }

  return { resolved, skipped }
}

function loadCustomProviderUrls(chainId, fileName, fromDir) {
  const filePath = path.join(fromDir, fileName)
  const config = loadCustomProviderFile(filePath)

  if (config.chainId !== chainId) {
    throw new Error(
      `${fileName} declares chainId ${config.chainId} but expected ${chainId}`,
    )
  }

  const result = buildUrlsFromProviderConfig(config)
  if (result.resolved.length === 0) {
    throw new Error(
      `No valid URLs resolved from ${fileName}. Add at least one entry with a valid key (URL or API key).`,
    )
  }

  return result
}

async function probeUrl(entry, chainId) {
  if (/YOUR_[A-Z_]+/.test(entry.url)) {
    return {
      name: entry.name,
      url: maskUrl(entry.url),
      pass: false,
      latencyMs: 0,
      error: 'placeholder value not replaced (YOUR_* detected) — add a real API key',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  const start = Date.now()

  try {
    const response = await fetch(entry.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        method: 'eth_blockNumber',
        params: [],
      }),
      signal: controller.signal,
    })

    const bodyText = await response.text()
    if (!response.ok) {
      throw new Error(
        `bad response (status=${response.status}, body=${bodyText.slice(0, 300)})`,
      )
    }

    let parsed
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      throw new Error(`invalid JSON response: ${bodyText.slice(0, 300)}`)
    }

    if (parsed.error) {
      throw new Error(JSON.stringify(parsed.error))
    }
    if (!parsed.result) {
      throw new Error('missing result in JSON-RPC response')
    }

    return {
      name: entry.name,
      url: entry.url,
      pass: true,
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    const message =
      err.name === 'AbortError'
        ? `Timed out after ${PROBE_TIMEOUT_MS}ms`
        : err.message ?? String(err)

    return {
      name: entry.name,
      url: entry.url,
      pass: false,
      latencyMs: Date.now() - start,
      error: scrubUrls(message),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function runProviderCheck(chains, fromDir) {
  const failures = []

  for (const chain of chains) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`Chain: ${chain.name} (chainId ${chain.chainId})`)
    console.log('─'.repeat(60))

    let result
    try {
      result = loadCustomProviderUrls(chain.chainId, chain.file, fromDir)
    } catch (err) {
      const msg = err.message
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
        failures.push({
          chain: chain.name,
          name: r.name,
          url: maskUrl(r.url),
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

async function main() {
  const fromDir = process.cwd()

  const missing = CHAINS.filter(({ file }) => !fs.existsSync(path.join(fromDir, file)))
  if (missing.length > 0) {
    console.error('Missing required provider config file(s) in current directory:')
    for (const chain of missing) {
      console.error(`  - ${chain.file}`)
    }
    console.error('\nCopy this script into the folder that contains both JSON files, then run:')
    console.error('  node check-mainnet-providers-standalone.js')
    process.exit(1)
  }

  await runProviderCheck(CHAINS, fromDir)
}

main().catch((err) => {
  console.error('[check-mainnet-providers] Unexpected error:', err)
  process.exit(1)
})
