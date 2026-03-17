import {createHash} from 'node:crypto'

const CHANNEL_EXPIRY_STEP_SECONDS = 30 * 60
export const DEFAULT_SHARDUS_CRYPTO_HASH_KEY = '69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc'

export function deriveDeterministicChannelId(normalizedTxId: string, txTimestampMs: number, nowSec?: number): string {
  if (!/^[a-f0-9]{64}$/.test(normalizedTxId)) {
    throw new Error(`Invalid normalized txId for deterministic channel id: ${normalizedTxId}`)
  }
  if (!Number.isFinite(txTimestampMs) || txTimestampMs <= 0) {
    throw new Error(`Invalid txTimestampMs for deterministic channel id: ${txTimestampMs}`)
  }

  const effectiveNowSec = nowSec ?? Math.floor(Date.now() / 1000)
  let expirySec = Math.floor(txTimestampMs / 1000) + CHANNEL_EXPIRY_STEP_SECONDS
  while (expirySec <= effectiveNowSec) {
    expirySec += CHANNEL_EXPIRY_STEP_SECONDS
  }

  const prefix = normalizedTxId.slice(0, 3).toUpperCase()
  const expiryHex = expirySec.toString(16).toUpperCase().padStart(8, '0')
  return `${prefix}${expiryHex}`
}

export function deriveDeterministicChannelPassword(channelId: string, cryptoHashKey: string): string {
  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required for deterministic channel password')
  }
  if (!cryptoHashKey || typeof cryptoHashKey !== 'string') {
    throw new Error('cryptoHashKey is required for deterministic channel password')
  }
  return createHash('sha256').update(`${channelId}:${cryptoHashKey}`).digest('hex')
}
