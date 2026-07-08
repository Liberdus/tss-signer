import axios from 'axios'
import os from 'node:os'
import type { ChainHealthCheckRunResult } from './providerHealthCheck'

export type TssProviderAlertSeverity = 'warning' | 'emergency'

export interface TssProviderAlertChain {
  chainId: number
  chainName: string
  totalProviderCount: number
  activeProviderCount: number
  activeProviderPercentage: number
  severity: TssProviderAlertSeverity
  failedProviders: string[]
}

export interface TssProviderAlertPayload {
  source: 'tss-signer'
  instanceId: string
  hostname: string
  hostIp?: string
  environment?: string
  generatedAt: string
  chains: TssProviderAlertChain[]
}

export interface TssProviderAlertIdentity {
  instanceId?: string
  hostname?: string
  hostIp?: string
  environment?: string
  generatedAt?: string
}

export interface SendTssProviderAlertOptions {
  statusServerBaseUrl?: string
  token?: string
  post?: typeof axios.post
}

const URL_LIKE_PATTERN = /(https?:\/\/|www\.|[?&][a-z0-9_-]+=|\/{2,}|[a-z0-9.-]+\.[a-z]{2,}\/)/i
const API_KEY_LIKE_PATTERN = /([a-z0-9_-]{24,}|api[_-]?key|token|secret|apikey)/i

export function classifyTssProviderHealth(
  activeProviderCount: number,
  totalProviderCount: number,
): TssProviderAlertSeverity | null {
  if (!Number.isFinite(activeProviderCount) || !Number.isFinite(totalProviderCount)) {
    return null
  }
  if (totalProviderCount <= 0 || activeProviderCount < 0) {
    return null
  }
  const percentage = (activeProviderCount / totalProviderCount) * 100
  if (percentage <= 20) return 'emergency'
  if (percentage <= 40) return 'warning'
  return null
}

function sanitizeProviderName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (URL_LIKE_PATTERN.test(trimmed) || API_KEY_LIKE_PATTERN.test(trimmed)) return null
  return trimmed.slice(0, 80)
}

export function buildTssProviderAlertPayload(
  results: ChainHealthCheckRunResult[],
  identity: TssProviderAlertIdentity = {},
): TssProviderAlertPayload | null {
  const chains: TssProviderAlertChain[] = []

  for (const result of results) {
    const totalProviderCount = result.configuredCount
    const activeProviderCount = result.healthyCount
    const severity = classifyTssProviderHealth(activeProviderCount, totalProviderCount)
    if (!severity) continue

    const activeProviderPercentage =
      totalProviderCount > 0 ? Math.round((activeProviderCount / totalProviderCount) * 100) : 0
    const failedProviders = result.probes
      .filter((probe) => !probe.pass)
      .map((probe) => sanitizeProviderName(probe.name))
      .filter((name): name is string => !!name)

    chains.push({
      chainId: result.chainId,
      chainName: result.chainName || `chain-${result.chainId}`,
      totalProviderCount,
      activeProviderCount,
      activeProviderPercentage,
      severity,
      failedProviders,
    })
  }

  if (chains.length === 0) return null

  return {
    source: 'tss-signer',
    instanceId: identity.instanceId || process.env.TSS_SIGNER_INSTANCE_ID || os.hostname(),
    hostname: identity.hostname || os.hostname(),
    hostIp: identity.hostIp || process.env.TSS_SIGNER_HOST_IP || undefined,
    environment: identity.environment || process.env.TSS_SIGNER_ENVIRONMENT || undefined,
    generatedAt: identity.generatedAt || new Date().toISOString(),
    chains,
  }
}

export async function sendTssProviderAlert(
  payload: TssProviderAlertPayload | null,
  options: SendTssProviderAlertOptions = {},
): Promise<boolean> {
  if (!payload || payload.chains.length === 0) return false

  const statusServerBaseUrl = options.statusServerBaseUrl || process.env.STATUS_SERVER_BASE_URL
  const token = options.token || process.env.TSS_PROVIDER_ALERT_TOKEN
  if (!statusServerBaseUrl || !token) return false

  const base = statusServerBaseUrl.replace(/\/+$/, '')
  const post = options.post || axios.post
  await post(`${base}/api/tss-provider-health/alert`, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 10_000,
    validateStatus: (status: number) => status >= 200 && status < 300,
  })
  return true
}
