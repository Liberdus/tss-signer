const Sntp = require('@hapi/sntp')

export const DEFAULT_TIME_SERVERS = ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org', '3.pool.ntp.org']
export const DEFAULT_NTP_SYNC_LIMIT_SECONDS = 180
export const DEFAULT_NTP_TIMEOUT_MS = 10_000

type SntpTimeResult = {
  t: number
}

type QueryNetworkTime = (host: string, timeout: number) => Promise<SntpTimeResult>

export type InitializeNetworkTimeOptions = {
  timeServers?: string[]
  syncLimitSeconds?: number
  timeoutMs?: number
  queryNetworkTime?: QueryNetworkTime
}

let ntpOffsetMs = 0
let initialized = false

async function defaultQueryNetworkTime(host: string, timeout: number): Promise<SntpTimeResult> {
  return Sntp.time({host, timeout})
}

export function getNetworkTimeOffsetMs(): number {
  return ntpOffsetMs
}

export function networkNowMs(): number {
  return Date.now() + ntpOffsetMs
}

export function networkNowSec(): number {
  return Math.floor(networkNowMs() / 1000)
}

export async function initializeNetworkTime(options: InitializeNetworkTimeOptions = {}): Promise<number> {
  const timeServers = options.timeServers ?? DEFAULT_TIME_SERVERS
  const syncLimitSeconds = options.syncLimitSeconds ?? DEFAULT_NTP_SYNC_LIMIT_SECONDS
  const timeoutMs = options.timeoutMs ?? DEFAULT_NTP_TIMEOUT_MS
  const queryNetworkTime = options.queryNetworkTime ?? defaultQueryNetworkTime
  const syncLimitMs = syncLimitSeconds * 1000
  let lastError: unknown

  for (const host of timeServers) {
    try {
      const time = await queryNetworkTime(host, timeoutMs)
      const offsetMs = Math.floor(time.t)
      if (Math.abs(offsetMs) > syncLimitMs) {
        throw new Error(
          `NTP offset ${offsetMs}ms from ${host} exceeds sync limit ${syncLimitMs}ms`,
        )
      }
      ntpOffsetMs = offsetMs
      initialized = true
      return ntpOffsetMs
    } catch (error) {
      lastError = error
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'no time servers configured')
  throw new Error(`Failed to initialize network time: ${reason}`)
}

export async function initializeNetworkTimeOrExit(): Promise<void> {
  try {
    const offsetMs = await initializeNetworkTime()
    console.log(`[network-time] NTP offset initialized: ${offsetMs}ms`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[network-time] ${reason}`)
    process.exit(1)
  }
}

export function resetNetworkTimeForTests(): void {
  ntpOffsetMs = 0
  initialized = false
}

export function isNetworkTimeInitialized(): boolean {
  return initialized
}
