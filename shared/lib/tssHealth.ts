import fs from 'node:fs'
import path from 'node:path'
import {writeJsonAtomically} from './atomicJson'

export const TSS_HEARTBEAT_INTERVAL_MS = 15_000
export const TSS_HEARTBEAT_MAX_AGE_MS = 45_000

export interface TssPartyHeartbeat {
  partyIndex: number
  updatedAt: string
}

export interface PairedProcessHealth {
  healthy: boolean
  partyIndex: number
  lastHeartbeatAt: string | null
  ageMs: number | null
}

export interface CombinedProcessHealth {
  statusCode: 200 | 503
  status: 'healthy' | 'unhealthy'
  observer: {healthy: boolean}
  tssParty: PairedProcessHealth
}

export function buildCombinedProcessHealth(
  observerHealthy: boolean,
  tssParty: PairedProcessHealth,
): CombinedProcessHealth {
  const healthy = observerHealthy && tssParty.healthy
  return {
    statusCode: healthy ? 200 : 503,
    status: healthy ? 'healthy' : 'unhealthy',
    observer: {healthy: observerHealthy},
    tssParty,
  }
}

export function resolvePartyHealthDir(partyIndex: number, cwd = process.cwd()): string {
  return path.join(cwd, 'db', `health-${partyIndex}`)
}

export function resolveHeartbeatPath(partyIndex: number, cwd = process.cwd()): string {
  return path.join(resolvePartyHealthDir(partyIndex, cwd), 'tss-party-heartbeat.json')
}

export function resolveProviderHealthPath(partyIndex: number, cwd = process.cwd()): string {
  return path.join(resolvePartyHealthDir(partyIndex, cwd), 'provider-health.json')
}

export function writeTssPartyHeartbeat(
  filePath: string,
  partyIndex: number,
  now = new Date(),
): TssPartyHeartbeat {
  const heartbeat = {partyIndex, updatedAt: now.toISOString()}
  writeJsonAtomically(filePath, heartbeat)
  return heartbeat
}

export function readPairedProcessHealth(
  filePath: string,
  expectedPartyIndex: number,
  nowMs = Date.now(),
  maxAgeMs = TSS_HEARTBEAT_MAX_AGE_MS,
): PairedProcessHealth {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<TssPartyHeartbeat>
    const updatedAtMs = typeof parsed.updatedAt === 'string' ? Date.parse(parsed.updatedAt) : NaN
    const ageMs = nowMs - updatedAtMs
    const valid = parsed.partyIndex === expectedPartyIndex && Number.isFinite(ageMs) && ageMs >= 0
    return {
      healthy: valid && ageMs <= maxAgeMs,
      partyIndex: expectedPartyIndex,
      lastHeartbeatAt: Number.isFinite(updatedAtMs) ? new Date(updatedAtMs).toISOString() : null,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
    }
  } catch (_error) {
    return {healthy: false, partyIndex: expectedPartyIndex, lastHeartbeatAt: null, ageMs: null}
  }
}

export function startTssPartyHeartbeat(
  filePath: string,
  partyIndex: number,
  intervalMs = TSS_HEARTBEAT_INTERVAL_MS,
): () => void {
  const refresh = () => {
    try {
      writeTssPartyHeartbeat(filePath, partyIndex)
    } catch (error) {
      console.warn(`[tss-health] Failed to refresh party ${partyIndex} heartbeat: ${(error as Error).message}`)
    }
  }
  refresh()
  const timer = setInterval(refresh, intervalMs)
  return () => clearInterval(timer)
}
