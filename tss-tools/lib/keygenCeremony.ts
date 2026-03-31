import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as bnbTss from './bnbTss'
import {resolveProjectRoot} from '../../shared/utils/paths'

const DEFAULT_CONFIG_NAME = 'keygen-config.json'
const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

// The native TSS channel format only requires an 11-char id whose final 8 chars
// decode to a future Unix timestamp. We bucket expiry to the next UTC midnight so
// operators in different time zones derive the same value without sharing another
// argument, as long as they run on the same UTC date.

export interface KeygenCeremonyConfig {
  chainId: number
  partyIps: string[]
}

export interface KeygenCeremonyDerivedConfig {
  parties: number
  threshold: number
  partyIdx: number
  partyIp: string
  listenPort: number
  listenAddr: string
  peerAddrs: string[]
}

function normalizeNonce(nonce: string): string {
  const normalized = `${nonce || ''}`.trim()
  if (!normalized) {
    throw new Error('nonce is required')
  }
  return normalized
}

function buildCeremonyMaterial(config: KeygenCeremonyConfig, nonce: string): string {
  return JSON.stringify({
    purpose: 'tss-keygen-ceremony-v1',
    chainId: config.chainId,
    partyIps: config.partyIps,
    nonce: normalizeNonce(nonce),
  })
}

export function resolveKeygenCeremonyConfigPath(
  configPath = DEFAULT_CONFIG_NAME,
  signerRoot = resolveProjectRoot(),
): string {
  return path.resolve(signerRoot, configPath)
}

export function validateKeygenCeremonyConfig(raw: unknown): KeygenCeremonyConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('keygen config must be a JSON object')
  }

  const chainId = Number.parseInt(String((raw as Record<string, unknown>).chainId), 10)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`chainId must be a positive integer, received ${(raw as Record<string, unknown>).chainId}`)
  }

  const rawPartyIps = (raw as Record<string, unknown>).partyIps
  if (!Array.isArray(rawPartyIps) || rawPartyIps.length < 2) {
    throw new Error('partyIps must be an array with at least 2 entries')
  }

  const partyIps = rawPartyIps.map((entry, index) => {
    const ip = `${entry || ''}`.trim()
    if (!IPV4_PATTERN.test(ip)) {
      throw new Error(`partyIps[${index}] is not a valid IPv4 address: ${entry}`)
    }
    return ip
  })

  if (new Set(partyIps).size !== partyIps.length) {
    throw new Error('partyIps must not contain duplicates')
  }

  return {chainId, partyIps}
}

export function loadKeygenCeremonyConfig(
  configPath = DEFAULT_CONFIG_NAME,
  signerRoot = resolveProjectRoot(),
): KeygenCeremonyConfig {
  const resolvedPath = resolveKeygenCeremonyConfigPath(configPath, signerRoot)
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Missing keygen config at ${resolvedPath}`)
  }
  return validateKeygenCeremonyConfig(JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as unknown)
}

export function deriveKeygenThreshold(parties: number): number {
  if (!Number.isInteger(parties) || parties < 2) {
    throw new Error(`parties must be an integer >= 2, received ${parties}`)
  }
  return Math.floor(parties / 2)
}

export function listLocalExternalIpv4s(): string[] {
  const networks = os.networkInterfaces()
  const candidates: string[] = []
  for (const addresses of Object.values(networks)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        candidates.push(address.address)
      }
    }
  }
  return Array.from(new Set(candidates)).sort()
}

export function detectPartyIndexFromIps(partyIps: string[], candidateIps: string[]): number {
  const matches = candidateIps
    .map((ip) => partyIps.indexOf(ip) + 1)
    .filter((idx) => idx > 0)

  if (matches.length === 1) {
    return matches[0]
  }
  if (matches.length > 1) {
    throw new Error(`Detected multiple matching party indexes from local IPs: ${matches.join(', ')}`)
  }
  throw new Error('Unable to match any local IPv4 address to partyIps')
}

export function deriveKeygenCeremonyConfig(
  config: KeygenCeremonyConfig,
  partyIdx: number,
): KeygenCeremonyDerivedConfig {
  const parties = config.partyIps.length
  const threshold = deriveKeygenThreshold(parties)
  if (!Number.isInteger(partyIdx) || partyIdx < 1 || partyIdx > parties) {
    throw new Error(`partyIdx must be within 1..${parties}, received ${partyIdx}`)
  }

  const partyIp = config.partyIps[partyIdx - 1]
  const listenPort = bnbTss.getDeterministicListenPort(config.chainId, partyIdx)
  const listenAddr = `/ip4/0.0.0.0/tcp/${listenPort}`
  const peerAddrs = config.partyIps
    .map((ip, index) => ({ip, partyIndex: index + 1}))
    .filter(({partyIndex}) => partyIndex !== partyIdx)
    .map(({ip, partyIndex}) => `/ip4/${ip}/tcp/${bnbTss.getDeterministicListenPort(config.chainId, partyIndex)}`)

  return {
    parties,
    threshold,
    partyIdx,
    partyIp,
    listenPort,
    listenAddr,
    peerAddrs,
  }
}

export function deriveNextUtcMidnightUnix(now = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0) / 1000)
}

export function deriveDeterministicKeygenChannelId(
  config: KeygenCeremonyConfig,
  nonce: string,
  now = new Date(),
): string {
  const digest = createHash('sha256').update(buildCeremonyMaterial(config, nonce)).digest()
  const prefix = (digest.readUInt16BE(0) % 1000).toString().padStart(3, '0')
  const expiryHex = deriveNextUtcMidnightUnix(now).toString(16).toUpperCase().padStart(8, '0')
  return `${prefix}${expiryHex}`
}

export function deriveDeterministicKeygenChannelPassword(
  config: KeygenCeremonyConfig,
  nonce: string,
  channelId = deriveDeterministicKeygenChannelId(config, nonce),
): string {
  return createHash('sha256')
    .update(`${channelId}:${buildCeremonyMaterial(config, nonce)}:channel-password`)
    .digest('hex')
}
