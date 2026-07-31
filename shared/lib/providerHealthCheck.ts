import axios from 'axios'
import { ChainConfig } from '../config'
import { ResolvedProviderUrl } from './customProviders'
import { removeHttpUrls, scrubUrls } from './rpcUrls'
import { writeJsonAtomically } from './atomicJson'

export const DEFAULT_HEALTH_CHECK_INTERVAL_HOURS = 24
const PROBE_TIMEOUT_MS = 15_000

const ETH_BLOCK_NUMBER_REQUEST = {
  jsonrpc: '2.0',
  method: 'eth_blockNumber',
  params: [] as [],
  id: 1,
}

const ETH_CHAIN_ID_REQUEST = {
  jsonrpc: '2.0',
  method: 'eth_chainId',
  params: [] as [],
  id: 2,
}

export type ProviderHealthCheckSource = (chainId: number) => readonly ResolvedProviderUrl[]
export type RpcProviderMode = 'custom' | 'chainlist' | 'both'
export type ProbeProviderUrlFn = (
  entry: ResolvedProviderUrl,
  chainId: number,
) => Promise<ProviderProbeResult>

export interface ProviderProbeResult {
  name: string
  url: string
  pass: boolean
  latencyMs: number
  blockNumber?: number
  error?: string
}

export interface ChainHealthCheckOutcome {
  chainId: number
  configuredCount: number
  healthyCount: number
}

export interface ChainHealthCheckRunResult extends ChainHealthCheckOutcome {
  probes: ProviderProbeResult[]
}

export interface CustomProviderHealthCheckOptions {
  intervalHours?: number
  rpcProviderMode: RpcProviderMode
  exit?: (code: number) => void
  reportPath?: string
}

export interface FailedProviderReportEntry {
  chainId: number
  chainName: string
  providerName: string
}

export type ProviderHealthSeverity = 'normal' | 'warning' | 'emergency'

export interface ChainProviderHealthReport {
  chainId: number
  chainName: string
  configuredCount: number
  healthyCount: number
  healthyPercentage: number
  severity: ProviderHealthSeverity
}

export interface ProviderHealthReport {
  checkedAt: string
  chains: ChainProviderHealthReport[]
  failedProviderCount: number
  failedProviders: FailedProviderReportEntry[]
}

export function providerHealthSeverity(healthyPercentage: number): ProviderHealthSeverity {
  if (healthyPercentage <= 20) return 'emergency'
  if (healthyPercentage <= 40) return 'warning'
  return 'normal'
}

export interface RunCustomProviderHealthCheckOptions {
  probeFn?: ProbeProviderUrlFn
}

export interface CustomProviderHealthCheckHandle {
  startupReady: Promise<void>
  stop: () => void
}

interface JsonRpcResponse {
  id?: number
  result?: unknown
  error?: { message?: string; code?: number }
}

export function parseEthBlockNumberResult(result: unknown): number {
  if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) {
    throw new Error('eth_blockNumber returned an invalid result')
  }
  const blockNumber = parseInt(result, 16)
  if (!Number.isFinite(blockNumber) || blockNumber < 0) {
    throw new Error('eth_blockNumber returned an invalid result')
  }
  return blockNumber
}

export function parseEthChainIdResult(result: unknown, expectedChainId: number): number {
  let chainId: number | undefined
  if (typeof result === 'string' && /^0x[0-9a-f]+$/i.test(result)) {
    chainId = parseInt(result, 16)
  } else if (typeof result === 'number' && Number.isFinite(result)) {
    chainId = result
  }

  if (chainId == null || !Number.isFinite(chainId) || chainId < 0) {
    throw new Error('eth_chainId returned an invalid result')
  }
  if (chainId !== expectedChainId) {
    throw new Error(`eth_chainId mismatch: expected ${expectedChainId}, got ${chainId}`)
  }
  return chainId
}

export function getFatalCustomProviderFailures(
  outcomes: ChainHealthCheckOutcome[],
  mode: RpcProviderMode,
): string[] {
  if (mode !== 'custom') {
    return []
  }

  const failures: string[] = []
  for (const outcome of outcomes) {
    if (outcome.configuredCount === 0) {
      failures.push(`chainId=${outcome.chainId}: no custom providers configured`)
      continue
    }
    if (outcome.healthyCount === 0) {
      failures.push(
        `chainId=${outcome.chainId}: no healthy custom providers (0/${outcome.configuredCount} passed)`,
      )
    }
  }
  return failures
}

export function handleFatalCustomProviderFailures(
  failures: string[],
  exit: (code: number) => void = process.exit,
): void {
  if (failures.length === 0) {
    return
  }
  console.error(
    `[providerHealthCheck] FATAL rpcProviderMode=custom — ${failures.join('; ')}`,
  )
  exit(1)
}

function formatProbeError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status
    const data = err.response?.data as JsonRpcResponse | undefined
    if (data?.error?.message) {
      return scrubUrls(data.error.message)
    }
    if (status != null) {
      return scrubUrls(`HTTP ${status}: ${err.message}`)
    }
    return scrubUrls(err.message)
  }
  return scrubUrls((err as Error)?.message ?? String(err))
}

function parseJsonRpcResult(data: unknown, id: number): unknown {
  if (Array.isArray(data)) {
    const item = data.find((entry) => (entry as JsonRpcResponse)?.id === id) as JsonRpcResponse | undefined
    if (!item) {
      throw new Error(`JSON-RPC response missing id=${id}`)
    }
    if (item.error) {
      const message = item.error.message ?? JSON.stringify(item.error)
      throw new Error(scrubUrls(message))
    }
    return item.result
  }

  const single = data as JsonRpcResponse
  if (single?.error) {
    const message = single.error.message ?? JSON.stringify(single.error)
    throw new Error(scrubUrls(message))
  }
  return single?.result
}

async function fetchProbeResultsViaHttp(
  url: string,
  expectedChainId: number,
  timeoutMs: number,
): Promise<number> {
  const blockNumberResponse = await axios.post<JsonRpcResponse>(
    url,
    ETH_BLOCK_NUMBER_REQUEST,
    {
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (status) => status >= 200 && status < 300,
    },
  )

  const blockNumber = parseEthBlockNumberResult(
    parseJsonRpcResult(blockNumberResponse.data, ETH_BLOCK_NUMBER_REQUEST.id),
  )

  const chainIdResponse = await axios.post<JsonRpcResponse>(
    url,
    ETH_CHAIN_ID_REQUEST,
    {
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (status) => status >= 200 && status < 300,
    },
  )
  parseEthChainIdResult(
    parseJsonRpcResult(chainIdResponse.data, ETH_CHAIN_ID_REQUEST.id),
    expectedChainId,
  )
  return blockNumber
}

export async function probeProviderUrl(
  entry: ResolvedProviderUrl,
  chainId: number,
): Promise<ProviderProbeResult> {
  if (/YOUR_[A-Z_]+/.test(entry.url)) {
    return {
      name: entry.name,
      url: entry.url,
      pass: false,
      latencyMs: 0,
      error: 'placeholder value not replaced (YOUR_* detected) — add a real API key',
    }
  }

  const start = Date.now()
  try {
    const blockNumber = await fetchProbeResultsViaHttp(entry.url, chainId, PROBE_TIMEOUT_MS)
    return {
      name: entry.name,
      url: entry.url,
      pass: true,
      latencyMs: Date.now() - start,
      blockNumber,
    }
  } catch (err) {
    return {
      name: entry.name,
      url: entry.url,
      pass: false,
      latencyMs: Date.now() - start,
      error: formatProbeError(err),
    }
  }
}

function logProbeResult(chainId: number, result: ProviderProbeResult): void {
  const status = result.pass ? 'pass' : 'fail'
  const latency = `latencyMs=${result.latencyMs}`
  const block =
    result.blockNumber != null ? ` blockNumber=${result.blockNumber}` : ''
  if (result.pass) {
    console.log(
      `[providerHealthCheck] chainId=${chainId} provider=${result.name} status=${status}${block} ${latency}`,
    )
    return
  }
  console.warn(
    `[providerHealthCheck] chainId=${chainId} provider=${result.name} status=${status} ${latency} failure=probe-failed`,
  )
}

function logChainProbeSummary(chainId: number, probes: ProviderProbeResult[]): void {
  const total = probes.length
  const passed = probes.filter((probe) => probe.pass).length

  if (passed === 0) {
    console.warn(
      `[providerHealthCheck] chainId=${chainId} summary: no healthy custom providers (0/${total} passed)`,
    )
    return
  }

  if (passed === total) {
    console.log(
      `[providerHealthCheck] chainId=${chainId} summary: all ${total} custom providers healthy`,
    )
    return
  }

  console.log(
    `[providerHealthCheck] chainId=${chainId} summary: ${passed}/${total} custom providers healthy`,
  )
}

export function pruneFailedProbeUrls(results: ChainHealthCheckRunResult[]): number {
  let totalRemoved = 0
  for (const result of results) {
    const failedProbes = result.probes.filter((probe) => !probe.pass)
    if (failedProbes.length === 0) continue

    const failedUrls = failedProbes.map((probe) => probe.url)
    const removed = removeHttpUrls(result.chainId, failedUrls)
    totalRemoved += removed
    if (removed === 0) continue

    for (const probe of failedProbes) {
      console.warn(
        `[providerHealthCheck] Removed provider from chainId=${result.chainId} RPC pool after startup probe: provider=${probe.name} failure=probe-failed`,
      )
    }
    console.warn(
      `[providerHealthCheck] Removed ${removed} failed provider URL(s) from chainId=${result.chainId} RPC pool after startup probe`,
    )
  }
  return totalRemoved
}

export async function runCustomProviderHealthCheck(
  chains: Array<Pick<ChainConfig, 'chainId' | 'name'>>,
  getResolvedProviders: ProviderHealthCheckSource,
  options: RunCustomProviderHealthCheckOptions = {},
): Promise<ChainHealthCheckRunResult[]> {
  const probeFn = options.probeFn ?? probeProviderUrl
  const results: ChainHealthCheckRunResult[] = []

  for (const chain of chains) {
    const entries = getResolvedProviders(chain.chainId)
    if (entries.length === 0) {
      console.warn(
        `[providerHealthCheck] chainId=${chain.chainId} skipped: no custom providers configured`,
      )
      results.push({
        chainId: chain.chainId,
        configuredCount: 0,
        healthyCount: 0,
        probes: [],
      })
      continue
    }

    const probes = await Promise.all(
      entries.map((entry) => probeFn(entry, chain.chainId)),
    )
    for (const probe of probes) {
      logProbeResult(chain.chainId, probe)
    }
    logChainProbeSummary(chain.chainId, probes)

    results.push({
      chainId: chain.chainId,
      configuredCount: entries.length,
      healthyCount: probes.filter((probe) => probe.pass).length,
      probes,
    })
  }

  return results
}

export async function runStartupProviderHealthCheck(
  chains: Array<Pick<ChainConfig, 'chainId' | 'name'>>,
  getResolvedProviders: ProviderHealthCheckSource,
  options: CustomProviderHealthCheckOptions & RunCustomProviderHealthCheckOptions,
): Promise<ChainHealthCheckRunResult[]> {
  const results = await runCustomProviderHealthCheck(chains, getResolvedProviders, {
    probeFn: options.probeFn,
  })
  pruneFailedProbeUrls(results)
  if (options.reportPath) {
    writeProviderHealthReport(options.reportPath, chains, results)
  }
  handleFatalCustomProviderFailures(
    getFatalCustomProviderFailures(results, options.rpcProviderMode),
    options.exit ?? process.exit,
  )
  return results
}

export function resolveHealthCheckIntervalMs(intervalHours?: number): number {
  const hours = intervalHours ?? DEFAULT_HEALTH_CHECK_INTERVAL_HOURS
  return hours * 60 * 60 * 1000
}

export function buildProviderHealthReport(
  chains: Array<Pick<ChainConfig, 'chainId' | 'name'>>,
  results: ChainHealthCheckRunResult[],
  checkedAt = new Date(),
): ProviderHealthReport {
  const chainNames = new Map(chains.map((chain) => [chain.chainId, chain.name]))
  const failedProviders = results.flatMap((result) =>
    result.probes
      .filter((probe) => !probe.pass)
      .map((probe) => ({
        chainId: result.chainId,
        chainName: chainNames.get(result.chainId) ?? `Chain ${result.chainId}`,
        providerName: probe.name,
      })),
  )
  const resultByChain = new Map(results.map((result) => [result.chainId, result]))
  const chainReports = chains.map((chain) => {
    const result = resultByChain.get(chain.chainId)
    const configuredCount = result?.configuredCount ?? 0
    const healthyCount = result?.healthyCount ?? 0
    const healthyPercentage = configuredCount === 0 ? 0 : (healthyCount / configuredCount) * 100
    return {
      chainId: chain.chainId,
      chainName: chain.name,
      configuredCount,
      healthyCount,
      healthyPercentage,
      severity: providerHealthSeverity(healthyPercentage),
    }
  })
  return {
    checkedAt: checkedAt.toISOString(),
    chains: chainReports,
    failedProviderCount: failedProviders.length,
    failedProviders,
  }
}

export function writeProviderHealthReport(
  filePath: string,
  chains: Array<Pick<ChainConfig, 'chainId' | 'name'>>,
  results: ChainHealthCheckRunResult[],
  checkedAt = new Date(),
): ProviderHealthReport {
  const report = buildProviderHealthReport(chains, results, checkedAt)
  writeJsonAtomically(filePath, report)
  return report
}

export function parseProviderHealthReport(value: unknown): ProviderHealthReport {
  if (!value || typeof value !== 'object') throw new Error('invalid provider health report')
  const raw = value as Partial<ProviderHealthReport>
  if (typeof raw.checkedAt !== 'string' || !Number.isFinite(Date.parse(raw.checkedAt))) {
    throw new Error('invalid provider health checkedAt')
  }
  if (!Array.isArray(raw.failedProviders)) throw new Error('invalid failedProviders')
  if (!Array.isArray(raw.chains)) throw new Error('invalid chains')
  const chains = raw.chains.map((entry) => {
    if (!entry || typeof entry.chainId !== 'number' || !Number.isFinite(entry.chainId) ||
        typeof entry.chainName !== 'string' || !Number.isInteger(entry.configuredCount) ||
        entry.configuredCount < 0 || !Number.isInteger(entry.healthyCount) ||
        entry.healthyCount < 0 || entry.healthyCount > entry.configuredCount ||
        typeof entry.healthyPercentage !== 'number' || !Number.isFinite(entry.healthyPercentage) ||
        entry.healthyPercentage < 0 || entry.healthyPercentage > 100 ||
        Math.abs(entry.healthyPercentage - (entry.configuredCount === 0
          ? 0 : entry.healthyCount / entry.configuredCount * 100)) > Number.EPSILON * 100 ||
        entry.severity !== providerHealthSeverity(entry.healthyPercentage)) {
      throw new Error('invalid chain health entry')
    }
    return {
      chainId: entry.chainId, chainName: entry.chainName,
      configuredCount: entry.configuredCount, healthyCount: entry.healthyCount,
      healthyPercentage: entry.healthyPercentage, severity: entry.severity,
    }
  })
  const failedProviders = raw.failedProviders.map((entry) => {
    if (!entry || typeof entry.chainId !== 'number' || !Number.isFinite(entry.chainId) ||
        typeof entry.chainName !== 'string' || typeof entry.providerName !== 'string') {
      throw new Error('invalid failed provider entry')
    }
    return {chainId: entry.chainId, chainName: entry.chainName, providerName: entry.providerName}
  })
  if (raw.failedProviderCount !== failedProviders.length) {
    throw new Error('failedProviderCount does not match failedProviders')
  }
  return {checkedAt: raw.checkedAt, chains, failedProviderCount: failedProviders.length, failedProviders}
}

export function startCustomProviderHealthCheck(
  chains: Array<Pick<ChainConfig, 'chainId' | 'name'>>,
  getResolvedProviders: ProviderHealthCheckSource,
  options: CustomProviderHealthCheckOptions,
): CustomProviderHealthCheckHandle {
  if (process.env.NODE_ENV === 'test') {
    return {
      startupReady: Promise.resolve(),
      stop: () => undefined,
    }
  }

  const intervalMs = resolveHealthCheckIntervalMs(options.intervalHours)
  const hours = intervalMs / (60 * 60 * 1000)
  const exit = options.exit ?? process.exit
  let interval: ReturnType<typeof setInterval> | undefined

  const startupReady = runStartupProviderHealthCheck(chains, getResolvedProviders, options)
    .then((results) => {
      interval = setInterval(() => {
        void runCustomProviderHealthCheck(chains, getResolvedProviders)
          .then((results) => {
            if (options.reportPath) {
              writeProviderHealthReport(options.reportPath, chains, results)
            }
            handleFatalCustomProviderFailures(
              getFatalCustomProviderFailures(results, options.rpcProviderMode),
              exit,
            )
          })
          .catch((err) => {
            console.warn(`[providerHealthCheck] Health check failed: ${(err as Error).message}`)
          })
      }, intervalMs)
      console.log(
        `[providerHealthCheck] Scheduled custom provider health checks every ${hours}h`,
      )
    })
    .catch((err) => {
      console.warn(`[providerHealthCheck] Startup health check failed: ${(err as Error).message}`)
      throw err
    })

  return {
    startupReady,
    stop: () => {
      if (interval) clearInterval(interval)
    },
  }
}
