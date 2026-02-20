/**
 * RPC URL list state and chainlist.org integration.
 * Maintains per-chain HTTP and WS URL lists, seeded from config and merged from chainlist.
 */

import axios from 'axios'

const CHAINLIST_RPCS_URL = 'https://chainlist.org/rpcs.json'
const HOURLY_MS = 60 * 60 * 1000

const httpRpcUrlsByChain: Map<number, string[]> = new Map()
const wsUrlsByChain: Map<number, string[]> = new Map()

/** TTL blacklist: URL -> expiry timestamp. Only for genuine errors (not rate limit, not timeout). */
const urlBlacklistExpiry = new Map<string, number>()
const DEFAULT_TTL_MS = 5 * 60 * 1000

export function applyInfuraKey(url: string, infuraKey: string): string {
  const u = (url || '').trim()
  if (!u || !infuraKey) return u
  if (/infura/i.test(u)) return `${u.replace(/\/+$/, '')}/${infuraKey}`
  return u
}

export interface ChainConfigForUrls {
  rpcUrl: string
  wsUrl: string
}

export function initFromConfig(
  supportedChains: Record<string, ChainConfigForUrls>,
  infuraKey: string,
): void {
  for (const [chainIdStr, config] of Object.entries(supportedChains)) {
    const chainId = parseInt(chainIdStr, 10)
    if (Number.isNaN(chainId)) continue

    const httpUrl = applyInfuraKey(config.rpcUrl, infuraKey)
    const wsUrl = applyInfuraKey(config.wsUrl, infuraKey)

    const httpList = httpRpcUrlsByChain.get(chainId) ?? []
    if (httpUrl && !httpList.includes(httpUrl)) httpList.push(httpUrl)
    httpRpcUrlsByChain.set(chainId, httpList)

    const wsList = wsUrlsByChain.get(chainId) ?? []
    if (wsUrl && !wsList.includes(wsUrl)) wsList.push(wsUrl)
    wsUrlsByChain.set(chainId, wsList)
  }
}

/**
 * Parse chainlist.org response (format treated as unknown).
 * Only uses chainId (not networkId). Appends Infura key for URLs containing "infura".
 */
export function mergeChainlistResponse(
  data: unknown,
  supportedChainIds: Set<number>,
  infuraKey: string,
): void {
  if (!Array.isArray(data)) return

  for (const item of data as unknown[]) {
    const chainId = typeof (item as any)?.chainId === 'number' ? (item as any).chainId : undefined
    if (chainId === undefined || !supportedChainIds.has(chainId)) continue

    const rpc = (item as any).rpc
    if (!Array.isArray(rpc)) continue

    const httpList = httpRpcUrlsByChain.get(chainId) ?? []
    const wsList = wsUrlsByChain.get(chainId) ?? []

    for (const entry of rpc) {
      const raw =
        typeof entry === 'string' ? entry : typeof entry?.url === 'string' ? entry.url : null
      if (!raw || typeof raw !== 'string') continue

      const url = applyInfuraKey(raw.trim(), infuraKey)
      if (!url) continue

      if ((url.startsWith('http://') || url.startsWith('https://')) && !httpList.includes(url)) {
        httpList.push(url)
      } else if (
        (url.startsWith('ws://') || url.startsWith('wss://')) &&
        !wsList.includes(url)
      ) {
        wsList.push(url)
      }
    }

    if (httpList.length) httpRpcUrlsByChain.set(chainId, httpList)
    if (wsList.length) wsUrlsByChain.set(chainId, wsList)
  }
}

export async function fetchChainlistAndMerge(
  supportedChainIds: number[],
  infuraKey: string,
): Promise<void> {
  const set = new Set(supportedChainIds)
  try {
    const res = await axios.get(CHAINLIST_RPCS_URL, { timeout: 15000 })
    mergeChainlistResponse(res.data as unknown, set, infuraKey)
  } catch (err: any) {
    console.warn('[rpcUrls] Chainlist fetch failed:', err?.message || err)
  }
}

/** Clear blacklist (for tests). */
export function clearUrlBlacklist(): void {
  urlBlacklistExpiry.clear()
}

/**
 * Mark a URL as failed (genuine error). It will be skipped until TTL expires.
 * Call only when shouldBlacklistForError(error) is true.
 */
export function markUrlFailed(url: string, ttlMs?: number, reason?: string): void {
  urlBlacklistExpiry.set(url, Date.now() + (ttlMs ?? DEFAULT_TTL_MS))
  const displayUrl = url.replace(/\/[a-f0-9-]+$/i, '/…')
  const reasonPart = reason ? ` – reason: ${reason}` : ''
  console.warn(`[rpcUrls] ⛔ Blacklisted RPC URL for ${((ttlMs ?? DEFAULT_TTL_MS) / 60000).toFixed(1)}m: ${displayUrl}${reasonPart}\n`)
}

/**
 * Pick one URL from the list, skipping blacklisted (non-expired) URLs.
 * Caller ensures non-empty list. After N attempts returns lastIterationURL so we never get stuck.
 */
export function pickAvailableUrlFromList(urls: string[]): string {
  const maxAttempts = urls.length
  let lastIterationURL = urls[0]
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = urls[Math.floor(Math.random() * urls.length)]
    lastIterationURL = url
    const expiry = urlBlacklistExpiry.get(url)
    if (expiry === undefined) return url
    if (Date.now() > expiry) {
      urlBlacklistExpiry.delete(url)
      return url
    }
  }
  return lastIterationURL
}

/**
 * True if the error should cause the URL to be blacklisted (genuine error).
 * False for rate limit (429), timeout, and rate-limit-like messages.
 */
export function shouldBlacklistForError(error: unknown): boolean {
  const msg = String((error as any)?.message ?? (error as any)?.code ?? error).toLowerCase()
  const code = (error as any)?.code
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET') return true
  if (code === 'NETWORK_ERROR') return true
  if (/could not detect network|no network|nonetwork/i.test(msg)) return true
  if (code === 'ETIMEDOUT') return false
  if (/timeout|timed out/i.test(msg)) return false
  if (/429|rate limit|too many requests|throttl/i.test(msg)) return false
  if (/5\d{2}/.test(String((error as any)?.status ?? (error as any)?.response?.status ?? ''))) return true
  if (/5\d{2}/.test(msg)) return true
  if (/econnrefused|enotfound|econnreset/i.test(msg)) return true
  if (/invalid response|parse error|unexpected token/i.test(msg)) return true
  return false
}

export function getHttpUrls(chainId: number): string[] {
  return httpRpcUrlsByChain.get(chainId) ?? []
}

export function getWsUrls(chainId: number): string[] {
  return wsUrlsByChain.get(chainId) ?? []
}

export function startHourlyChainlistFetch(
  supportedChainIds: number[],
  infuraKey: string,
): () => void {
  fetchChainlistAndMerge(supportedChainIds, infuraKey).then(() => {
    console.log('[rpcUrls] Initial chainlist fetch completed')
  })

  const interval = setInterval(() => {
    fetchChainlistAndMerge(supportedChainIds, infuraKey).then(() => {
      if (process.env.NODE_ENV !== 'test') {
        console.log('[rpcUrls] Hourly chainlist merge completed')
      }
    })
  }, HOURLY_MS)

  return () => clearInterval(interval)
}
