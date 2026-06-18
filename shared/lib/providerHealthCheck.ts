import axios from 'axios'
import { ChainConfig } from '../config'
import { ResolvedProviderUrl } from './customProviders'
import { redactRpcUrlForLog } from './redactForLog'
import { scrubUrls } from './rpcUrls'

export const DEFAULT_HEALTH_CHECK_INTERVAL_HOURS = 24
const PROBE_TIMEOUT_MS = 15_000

const ETH_BLOCK_NUMBER_REQUEST = {
  jsonrpc: '2.0',
  method: 'eth_blockNumber',
  params: [] as [],
  id: 1,
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

export interface CustomProviderHealthCheckOptions {
  intervalHours?: number
  rpcProviderMode: RpcProviderMode
  exit?: (code: number) => void
}

export interface RunCustomProviderHealthCheckOptions {
  probeFn?: ProbeProviderUrlFn
}

interface JsonRpcResponse {
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

async function fetchBlockNumberViaHttp(url: string, timeoutMs: number): Promise<number> {
  const response = await axios.post<JsonRpcResponse>(url, ETH_BLOCK_NUMBER_REQUEST, {
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' },
    validateStatus: (status) => status >= 200 && status < 300,
  })

  const data = response.data
  if (data?.error) {
    const message = data.error.message ?? JSON.stringify(data.error)
    throw new Error(scrubUrls(message))
  }

  return parseEthBlockNumberResult(data?.result)
}

export async function probeProviderUrl(
  entry: ResolvedProviderUrl,
  _chainId: number,
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
    const blockNumber = await fetchBlockNumberViaHttp(entry.url, PROBE_TIMEOUT_MS)
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
  const url = redactRpcUrlForLog(result.url)
  const latency = `latencyMs=${result.latencyMs}`
  const block =
    result.blockNumber != null ? ` blockNumber=${result.blockNumber}` : ''
  if (result.pass) {
    console.log(
      `[providerHealthCheck] chainId=${chainId} provider=${result.name} status=${status}${block} ${latency} url=${url}`,
    )
    return
  }
  const error = result.error ? ` error=${result.error}` : ''
  console.warn(
    `[providerHealthCheck] chainId=${chainId} provider=${result.name} status=${status} ${latency}${error} url=${url}`,
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

export async function runCustomProviderHealthCheck(
  chains: Array<Pick<ChainConfig, 'chainId' | 'name'>>,
  getResolvedProviders: ProviderHealthCheckSource,
  options: RunCustomProviderHealthCheckOptions = {},
): Promise<ChainHealthCheckOutcome[]> {
  const probeFn = options.probeFn ?? probeProviderUrl
  const outcomes: ChainHealthCheckOutcome[] = []

  for (const chain of chains) {
    const entries = getResolvedProviders(chain.chainId)
    if (entries.length === 0) {
      console.warn(
        `[providerHealthCheck] chainId=${chain.chainId} skipped: no custom providers configured`,
      )
      outcomes.push({
        chainId: chain.chainId,
        configuredCount: 0,
        healthyCount: 0,
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

    outcomes.push({
      chainId: chain.chainId,
      configuredCount: entries.length,
      healthyCount: probes.filter((probe) => probe.pass).length,
    })
  }

  return outcomes
}

export function resolveHealthCheckIntervalMs(intervalHours?: number): number {
  const hours = intervalHours ?? DEFAULT_HEALTH_CHECK_INTERVAL_HOURS
  return hours * 60 * 60 * 1000
}

export function startCustomProviderHealthCheck(
  chains: Array<Pick<ChainConfig, 'chainId' | 'name'>>,
  getResolvedProviders: ProviderHealthCheckSource,
  options: CustomProviderHealthCheckOptions,
): () => void {
  if (process.env.NODE_ENV === 'test') {
    return () => undefined
  }

  const intervalMs = resolveHealthCheckIntervalMs(options.intervalHours)
  const hours = intervalMs / (60 * 60 * 1000)
  const exit = options.exit ?? process.exit

  const run = async () => {
    try {
      const outcomes = await runCustomProviderHealthCheck(chains, getResolvedProviders)
      handleFatalCustomProviderFailures(
        getFatalCustomProviderFailures(outcomes, options.rpcProviderMode),
        exit,
      )
    } catch (err) {
      console.warn(`[providerHealthCheck] Health check failed: ${(err as Error).message}`)
    }
  }

  void run()

  const interval = setInterval(() => {
    void run()
  }, intervalMs)
  console.log(
    `[providerHealthCheck] Scheduled custom provider health checks every ${hours}h`,
  )

  return () => clearInterval(interval)
}
