#!/usr/bin/env node
import axios from 'axios'
import {ethers} from 'ethers'
import {loadCustomProviderUrls, ResolvedProviderUrl} from '../shared/lib/customProviders'
import {probeProviderUrl} from '../shared/lib/providerHealthCheck'
import {redactRpcUrlForLog} from '../shared/lib/redactForLog'
import {chainConfigsRaw, getChainConfigById, isSigningChainConfig, toNetworkChainId} from '../shared/config'

type ChainTarget = {
  chainId: number
  name: string
}

type CliOptions = {
  chains: ChainTarget[]
  iterations: number
  mode: 'both' | 'http' | 'provider'
  interaction: 'construct-only' | 'health' | 'tss-startup'
  sampleSize: number
}

type MemorySnapshot = {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

const DEV_CHAINS: ChainTarget[] = [
  {chainId: 80002, name: 'Polygon Amoy Testnet'},
  {chainId: 97, name: 'BSC Testnet'},
]

const MAINNET_CHAINS: ChainTarget[] = [
  {chainId: 137, name: 'Polygon Mainnet'},
  {chainId: 56, name: 'BSC Mainnet'},
]

const BRIDGE_CONTRACT_ABI = [
  'function bridgeInCooldown() view returns (uint256)',
  'function maxBridgeInAmount() view returns (uint256)',
  'function lastBridgeInTime() view returns (uint256)',
]
const BRIDGE_CONTRACT_IFACE = new ethers.utils.Interface(BRIDGE_CONTRACT_ABI)
const RPC_TIMEOUT_MS = 15_000

function usage(): never {
  console.log('Usage: node dist/scripts/profile-rpc-provider-memory.js [--dev|--mainnet] [--chain-id <id>] [--iterations <n>] [--mode http|provider|both] [--interaction construct-only|health|tss-startup] [--sample-size <n>]')
  console.log('')
  console.log('Examples:')
  console.log('  node --expose-gc dist/scripts/profile-rpc-provider-memory.js --dev --iterations 5 --interaction tss-startup --sample-size 10')
  console.log('  node --expose-gc dist/scripts/profile-rpc-provider-memory.js --dev --interaction construct-only --sample-size 10')
  console.log('  node --expose-gc dist/scripts/profile-rpc-provider-memory.js --chain-id 80002 --mode both --interaction health')
  process.exit(1)
}

function parseArgs(argv: string[]): CliOptions {
  let chains = DEV_CHAINS
  let iterations = 3
  let mode: CliOptions['mode'] = 'both'
  let interaction: CliOptions['interaction'] = 'tss-startup'
  let sampleSize = 10

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dev') {
      chains = DEV_CHAINS
    } else if (arg === '--mainnet') {
      chains = MAINNET_CHAINS
    } else if (arg === '--chain-id') {
      const value = Number.parseInt(argv[i + 1], 10)
      if (!Number.isInteger(value)) usage()
      const known = [...DEV_CHAINS, ...MAINNET_CHAINS].find((chain) => chain.chainId === value)
      chains = [{chainId: value, name: known?.name ?? `chain ${value}`}]
      i += 1
    } else if (arg === '--iterations') {
      const value = Number.parseInt(argv[i + 1], 10)
      if (!Number.isInteger(value) || value < 1) usage()
      iterations = value
      i += 1
    } else if (arg === '--mode') {
      const value = argv[i + 1]
      if (value !== 'http' && value !== 'provider' && value !== 'both') usage()
      mode = value
      i += 1
    } else if (arg === '--interaction') {
      const value = argv[i + 1]
      if (value !== 'construct-only' && value !== 'health' && value !== 'tss-startup') usage()
      interaction = value
      i += 1
    } else if (arg === '--sample-size') {
      const value = Number.parseInt(argv[i + 1], 10)
      if (!Number.isInteger(value) || value < 1) usage()
      sampleSize = value
      i += 1
    } else {
      usage()
    }
  }

  return {chains, iterations, mode, interaction, sampleSize}
}

function forceGc(): void {
  if (typeof global.gc === 'function') {
    global.gc()
  }
}

function snapshotMemory(): MemorySnapshot {
  forceGc()
  const usage = process.memoryUsage()
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function logMemoryDelta(label: string, before: MemorySnapshot, after: MemorySnapshot): void {
  console.log(
    `[${label}] rss=${formatMb(after.rss)} delta=${formatMb(after.rss - before.rss)} ` +
    `heapUsed=${formatMb(after.heapUsed)} delta=${formatMb(after.heapUsed - before.heapUsed)} ` +
    `external=${formatMb(after.external)} delta=${formatMb(after.external - before.external)} ` +
    `arrayBuffers=${formatMb(after.arrayBuffers)} delta=${formatMb(after.arrayBuffers - before.arrayBuffers)}`,
  )
}

function loadEntries(chains: ChainTarget[]): Array<{chain: ChainTarget; entry: ResolvedProviderUrl}> {
  const entries: Array<{chain: ChainTarget; entry: ResolvedProviderUrl}> = []
  const seenUrls = new Set<string>()
  for (const chain of chains) {
    const loaded = loadCustomProviderUrls(chain.chainId)
    console.log(`[load] ${chain.name} (${chain.chainId}): ${loaded.resolved.length} resolved, ${loaded.skipped.length} skipped`)
    for (const skipped of loaded.skipped) {
      console.log(`[load] skipped ${chain.chainId} provider=${skipped.name} reason=${skipped.reason}`)
    }
    for (const entry of loaded.resolved) {
      if (seenUrls.has(entry.url)) continue
      seenUrls.add(entry.url)
      entries.push({chain, entry})
    }
  }
  return entries
}

function selectProfileEntries(
  entries: Array<{chain: ChainTarget; entry: ResolvedProviderUrl}>,
  sampleSize: number,
): Array<{chain: ChainTarget; entry: ResolvedProviderUrl}> {
  return entries.slice(0, sampleSize)
}

function requireTssStartupConfig(chainId: number): {contractAddress: string; tssSenderAddress: string} {
  const config = getChainConfigById(chainConfigsRaw, chainId)
  if (!config || !isSigningChainConfig(config)) {
    throw new Error(`[profile] chainId ${chainId} is missing a signing config with tssSenderAddress`)
  }
  return {
    contractAddress: config.contractAddress,
    tssSenderAddress: config.tssSenderAddress,
  }
}

function summarizeBigNumber(value: ethers.BigNumber): string {
  const text = value.toString()
  return text.length > 24 ? `${text.slice(0, 24)}...` : text
}

async function jsonRpcCall(url: string, id: number, method: string, params: unknown[]): Promise<any> {
  const response = await axios.post(url, {jsonrpc: '2.0', id, method, params}, {timeout: RPC_TIMEOUT_MS})
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`)
  }
  if (response.data?.error) {
    throw new Error(`JSON-RPC ${method} error=${response.data.error.message ?? JSON.stringify(response.data.error)}`)
  }
  if (!response.data || response.data.result == null) {
    throw new Error(`JSON-RPC ${method} missing result`)
  }
  return response.data.result
}

async function runHttpHealthProbe(chain: ChainTarget, entry: ResolvedProviderUrl): Promise<boolean> {
  const result = await probeProviderUrl(entry, chain.chainId)
  console.log(
    `[http] chain=${chain.chainId} provider=${entry.name} pass=${result.pass} ` +
    `latencyMs=${result.latencyMs} block=${result.blockNumber ?? '-'} url=${redactRpcUrlForLog(entry.url)} ` +
    `${result.error ? `error=${result.error}` : ''}`,
  )
  return result.pass
}

async function runHttpTssStartupProbe(chain: ChainTarget, entry: ResolvedProviderUrl): Promise<boolean> {
  const started = Date.now()
  const {contractAddress, tssSenderAddress} = requireTssStartupConfig(chain.chainId)

  try {
    const [
      nonceRaw,
      balanceRaw,
      cooldownRaw,
      maxAmountRaw,
      lastTimeRaw,
      latestBlock,
      gasPriceRaw,
      chainIdRaw,
    ] = await Promise.all([
      jsonRpcCall(entry.url, 1, 'eth_getTransactionCount', [tssSenderAddress, 'latest']),
      jsonRpcCall(entry.url, 2, 'eth_getBalance', [tssSenderAddress, 'latest']),
      jsonRpcCall(entry.url, 3, 'eth_call', [{to: contractAddress, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('bridgeInCooldown')}, 'latest']),
      jsonRpcCall(entry.url, 4, 'eth_call', [{to: contractAddress, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('maxBridgeInAmount')}, 'latest']),
      jsonRpcCall(entry.url, 5, 'eth_call', [{to: contractAddress, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('lastBridgeInTime')}, 'latest']),
      jsonRpcCall(entry.url, 6, 'eth_getBlockByNumber', ['latest', false]),
      jsonRpcCall(entry.url, 7, 'eth_gasPrice', []),
      jsonRpcCall(entry.url, 8, 'eth_chainId', []),
    ])

    const chainId = Number.parseInt(chainIdRaw, 16)
    const pass = chainId === toNetworkChainId(chain.chainId)
    const nonce = Number.parseInt(nonceRaw, 16)
    const block = Number.parseInt(latestBlock?.number ?? '0x0', 16)
    const balance = ethers.BigNumber.from(balanceRaw)
    const gasPrice = ethers.BigNumber.from(gasPriceRaw)
    const cooldown = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('bridgeInCooldown', cooldownRaw)[0].toNumber()
    const maxAmount = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('maxBridgeInAmount', maxAmountRaw)[0]
    const lastTime = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('lastBridgeInTime', lastTimeRaw)[0].toNumber()
    console.log(
      `[http:tss-startup] chain=${chain.chainId} provider=${entry.name} pass=${pass} ` +
      `latencyMs=${Date.now() - started} nonce=${nonce} balance=${summarizeBigNumber(balance)} ` +
      `block=${block} gasPrice=${summarizeBigNumber(gasPrice)} ` +
      `cooldown=${cooldown}s maxBridgeInAmount=${summarizeBigNumber(maxAmount)} lastBridgeInTime=${lastTime} ` +
      `url=${redactRpcUrlForLog(entry.url)}`,
    )
    return pass
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.log(
      `[http:tss-startup] chain=${chain.chainId} provider=${entry.name} pass=false ` +
      `latencyMs=${Date.now() - started} url=${redactRpcUrlForLog(entry.url)} error=${reason}`,
    )
    return false
  }
}

async function runProviderHealthProbe(
  chain: ChainTarget,
  entry: ResolvedProviderUrl,
  provider: ethers.providers.JsonRpcProvider,
): Promise<boolean> {
  const started = Date.now()
  try {
    const [blockNumber, network] = await Promise.all([
      provider.getBlockNumber(),
      provider.getNetwork(),
    ])
    const pass = network.chainId === toNetworkChainId(chain.chainId)
    console.log(
      `[provider] chain=${chain.chainId} provider=${entry.name} pass=${pass} ` +
      `latencyMs=${Date.now() - started} block=${blockNumber} networkChainId=${network.chainId} ` +
      `url=${redactRpcUrlForLog(entry.url)}`,
    )
    return pass
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.log(
      `[provider] chain=${chain.chainId} provider=${entry.name} pass=false ` +
      `latencyMs=${Date.now() - started} url=${redactRpcUrlForLog(entry.url)} error=${reason}`,
    )
    return false
  }
}

async function runProviderTssStartupProbe(
  chain: ChainTarget,
  entry: ResolvedProviderUrl,
  provider: ethers.providers.JsonRpcProvider,
): Promise<boolean> {
  const started = Date.now()
  const {contractAddress, tssSenderAddress} = requireTssStartupConfig(chain.chainId)

  try {
    const [nonce, balance, cooldownRaw, maxAmountRaw, lastTimeRaw, latestBlock, gasPrice, network] = await Promise.all([
      provider.getTransactionCount(tssSenderAddress),
      provider.getBalance(tssSenderAddress),
      provider.call({to: contractAddress, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('bridgeInCooldown')}),
      provider.call({to: contractAddress, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('maxBridgeInAmount')}),
      provider.call({to: contractAddress, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('lastBridgeInTime')}),
      provider.getBlock('latest'),
      provider.getGasPrice(),
      provider.getNetwork(),
    ])
    const pass = network.chainId === toNetworkChainId(chain.chainId)
    const cooldown = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('bridgeInCooldown', cooldownRaw)[0].toNumber()
    const maxAmount = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('maxBridgeInAmount', maxAmountRaw)[0]
    const lastTime = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('lastBridgeInTime', lastTimeRaw)[0].toNumber()
    console.log(
      `[provider:tss-startup] chain=${chain.chainId} provider=${entry.name} pass=${pass} ` +
      `latencyMs=${Date.now() - started} nonce=${nonce} balance=${summarizeBigNumber(balance)} ` +
      `block=${latestBlock.number} gasPrice=${summarizeBigNumber(gasPrice)} cooldown=${cooldown}s ` +
      `maxBridgeInAmount=${summarizeBigNumber(maxAmount)} lastBridgeInTime=${lastTime} ` +
      `networkChainId=${network.chainId} url=${redactRpcUrlForLog(entry.url)}`,
    )
    return pass
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.log(
      `[provider:tss-startup] chain=${chain.chainId} provider=${entry.name} pass=false ` +
      `latencyMs=${Date.now() - started} url=${redactRpcUrlForLog(entry.url)} error=${reason}`,
    )
    return false
  }
}

async function runProfile(
  label: 'http' | 'provider',
  entries: Array<{chain: ChainTarget; entry: ResolvedProviderUrl}>,
  iterations: number,
  interaction: CliOptions['interaction'],
): Promise<void> {
  console.log(`\n[${label}] profiling ${entries.length} provider URL(s), iterations=${iterations}, interaction=${interaction}`)
  const before = snapshotMemory()
  let passed = 0
  let failed = 0

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    console.log(`\n[${label}] iteration ${iteration}/${iterations}`)
    if (label === 'http') {
      const urls = entries.map(({entry}) => entry.url)
      logMemoryDelta(`${label}:after-${urls.length}-url-strings`, before, snapshotMemory())
      if (interaction === 'construct-only') {
        passed += urls.length
        logMemoryDelta(`${label}:after-iteration-${iteration}`, before, snapshotMemory())
        continue
      }
      const results = await Promise.all(entries.map(({chain, entry}) =>
        interaction === 'health'
          ? runHttpHealthProbe(chain, entry)
          : runHttpTssStartupProbe(chain, entry),
      ))
      for (const ok of results) {
        if (ok) passed += 1
        else failed += 1
      }
    } else {
      const providers = entries.map(({chain, entry}) => new ethers.providers.JsonRpcProvider(entry.url, {
        chainId: toNetworkChainId(chain.chainId),
        name: 'unknown',
      }))
      logMemoryDelta(`${label}:after-${providers.length}-provider-objects`, before, snapshotMemory())
      if (interaction === 'construct-only') {
        passed += providers.length
        logMemoryDelta(`${label}:after-iteration-${iteration}`, before, snapshotMemory())
        for (const provider of providers) {
          const maybeProvider = provider as ethers.providers.JsonRpcProvider & {destroy?: () => void}
          if (typeof maybeProvider.destroy === 'function') {
            maybeProvider.destroy()
          }
        }
        continue
      }
      try {
        const results = await Promise.all(entries.map(({chain, entry}, index) =>
          interaction === 'health'
            ? runProviderHealthProbe(chain, entry, providers[index])
            : runProviderTssStartupProbe(chain, entry, providers[index]),
        ))
        for (const ok of results) {
          if (ok) passed += 1
          else failed += 1
        }
      } finally {
        for (const provider of providers) {
          const maybeProvider = provider as ethers.providers.JsonRpcProvider & {destroy?: () => void}
          if (typeof maybeProvider.destroy === 'function') {
            maybeProvider.destroy()
          }
        }
      }
    }
    logMemoryDelta(`${label}:after-iteration-${iteration}`, before, snapshotMemory())
  }

  const after = snapshotMemory()
  console.log(`\n[${label}] result passed=${passed} failed=${failed}`)
  logMemoryDelta(`${label}:final`, before, after)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (typeof global.gc !== 'function') {
    console.warn('[memory] global.gc is not available. Run with node --expose-gc for cleaner before/after readings.')
  }

  const entries = selectProfileEntries(loadEntries(options.chains), options.sampleSize)
  console.log(`[profile] selected ${entries.length} unique provider URL(s), sampleSize=${options.sampleSize}`)
  for (const {chain, entry} of entries) {
    console.log(`[profile] target chain=${chain.chainId} provider=${entry.name} url=${redactRpcUrlForLog(entry.url)}`)
  }
  if (options.mode === 'http' || options.mode === 'both') {
    await runProfile('http', entries, options.iterations, options.interaction)
  }
  if (options.mode === 'provider' || options.mode === 'both') {
    await runProfile('provider', entries, options.iterations, options.interaction)
  }
}

main().catch((error) => {
  console.error('[profile-rpc-provider-memory] Fatal error:', error)
  process.exit(1)
})
