import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as bnbTss from './bnbTss'
import {resolveProjectRoot} from '../../shared/utils/paths'
import {
  deriveNextUtcMidnightUnix,
  listLocalExternalIpv4s,
  lookupExternalIpv4s,
  resolvePartyIndexFromCandidates,
} from './keygenCeremony'

const DEFAULT_CONFIG_NAME = 'regroup-config.json'
const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

export interface RegroupCeremonyConfig {
  chainId: number
  oldPartyIps: string[]
  newPartyIps: string[]
  oldThreshold: number
  newThreshold: number
}

export interface RegroupCeremonyDerivedConfig {
  chainId: number
  committeePosition: number
  committeePartyIp: string
  oldParties: number
  newParties: number
  oldThreshold: number
  newThreshold: number
  isOld: boolean
  isNewMember: boolean
  newListenPort?: number
  newListenAddr?: string
  newPeerAddrs: string[]
}

export type OrderedRegroupPeerAddrsOptions = {
  chainId: number
  oldPartyIps: string[]
  newPartyIps: string[]
  oldThreshold: number
  committeePartyIp: string
  isOld?: boolean
  isNewMember?: boolean
}

function normalizeNonce(nonce: string): string {
  const normalized = `${nonce || ''}`.trim()
  if (!normalized) {
    throw new Error('nonce is required')
  }
  return normalized
}

function validateIpList(fieldName: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`${fieldName} must be an array with at least 2 entries`)
  }

  const ips = value.map((entry, index) => {
    const ip = `${entry || ''}`.trim()
    if (!IPV4_PATTERN.test(ip)) {
      throw new Error(`${fieldName}[${index}] is not a valid IPv4 address: ${entry}`)
    }
    return ip
  })

  if (new Set(ips).size !== ips.length) {
    throw new Error(`${fieldName} must not contain duplicates`)
  }

  return ips
}

function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function buildCeremonyMaterial(config: RegroupCeremonyConfig, nonce: string): string {
  return JSON.stringify({
    purpose: 'tss-regroup-ceremony-v1',
    chainId: config.chainId,
    oldPartyIps: sortIps(config.oldPartyIps),
    newPartyIps: config.newPartyIps,
    oldThreshold: config.oldThreshold,
    newThreshold: config.newThreshold,
    nonce: normalizeNonce(nonce),
  })
}

function getOldPeerAddr(ip: string, chainId: number): string {
  return `/ip4/${ip}/tcp/${bnbTss.getDefaultSlotListenPort(chainId)}`
}

function getNewPeerAddr(ip: string, chainId: number): string {
  return `/ip4/${ip}/tcp/${bnbTss.getDeterministicRegroupListenPort(chainId, bnbTss.DEFAULT_SLOT_PARTY_IDX)}`
}

function pushUniqueAddr(target: string[], addr: string): void {
  if (!target.includes(addr)) {
    target.push(addr)
  }
}

function sortIps(ips: string[]): string[] {
  return [...ips].sort((a, b) => a.localeCompare(b))
}

export function resolveRegroupCeremonyConfigPath(
  configPath = DEFAULT_CONFIG_NAME,
  signerRoot = resolveProjectRoot(),
): string {
  return path.resolve(signerRoot, configPath)
}

export function validateRegroupCeremonyConfig(raw: unknown): RegroupCeremonyConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('regroup config must be a JSON object')
  }

  const source = raw as Record<string, unknown>
  const chainId = Number.parseInt(String(source.chainId), 10)
  const oldThreshold = Number.parseInt(String(source.oldThreshold), 10)
  const newThreshold = Number.parseInt(String(source.newThreshold), 10)
  const oldPartyIps = validateIpList('oldPartyIps', source.oldPartyIps)
  const newPartyIps = validateIpList('newPartyIps', source.newPartyIps)

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`chainId must be a positive integer, received ${source.chainId}`)
  }
  if (!Number.isInteger(oldThreshold) || oldThreshold < 1) {
    throw new Error(`oldThreshold must be an integer >= 1, received ${source.oldThreshold}`)
  }
  if (!Number.isInteger(newThreshold) || newThreshold < 1) {
    throw new Error(`newThreshold must be an integer >= 1, received ${source.newThreshold}`)
  }
  if (oldThreshold + 1 !== oldPartyIps.length) {
    throw new Error(`oldPartyIps length (${oldPartyIps.length}) must equal oldThreshold + 1 (${oldThreshold + 1})`)
  }
  for (const ip of oldPartyIps) {
    if (!newPartyIps.includes(ip)) {
      throw new Error(`oldPartyIp ${ip} must also be present in newPartyIps`)
    }
  }
  if (newThreshold + 1 > newPartyIps.length) {
    throw new Error(`newThreshold + 1 (${newThreshold + 1}) cannot exceed newPartyIps length (${newPartyIps.length})`)
  }

  return {chainId, oldPartyIps, newPartyIps, oldThreshold, newThreshold}
}

export function loadRegroupCeremonyConfig(
  configPath = DEFAULT_CONFIG_NAME,
  signerRoot = resolveProjectRoot(),
): RegroupCeremonyConfig {
  const resolvedPath = resolveRegroupCeremonyConfigPath(configPath, signerRoot)
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Missing regroup config at ${resolvedPath}`)
  }
  return validateRegroupCeremonyConfig(JSON.parse(stripUtf8Bom(fs.readFileSync(resolvedPath, 'utf8'))) as unknown)
}

export function deriveOrderedRegroupPeerAddrs(options: OrderedRegroupPeerAddrsOptions): string[] {
  const {
    chainId,
    oldPartyIps,
    newPartyIps,
    oldThreshold,
    committeePartyIp,
    isOld = false,
    isNewMember = false,
  } = options

  if (isOld && isNewMember) {
    throw new Error('Ordered regroup wrapper roles are mutually exclusive: use --is-old for a carry-over member or --is-new-member for a fresh new member.')
  }
  if (!isOld && !isNewMember) {
    throw new Error('Ordered regroup peer derivation requires either --is-old or --is-new-member.')
  }
  if (!Array.isArray(oldPartyIps) || oldPartyIps.length < 2) {
    throw new Error(`oldPartyIps must contain at least 2 entries, received ${oldPartyIps}`)
  }
  if (!Array.isArray(newPartyIps) || newPartyIps.length < 2) {
    throw new Error(`newPartyIps must contain at least 2 entries, received ${newPartyIps}`)
  }
  if (new Set(oldPartyIps).size !== oldPartyIps.length) {
    throw new Error('oldPartyIps must not contain duplicates')
  }
  if (new Set(newPartyIps).size !== newPartyIps.length) {
    throw new Error('newPartyIps must not contain duplicates')
  }

  const newParties = newPartyIps.length
  const oldParticipantIps = sortIps(oldPartyIps)
  const oldAndNewIps = oldParticipantIps.filter((ip) => newPartyIps.includes(ip))
  const newOnlyIps = newPartyIps.filter((ip) => !oldParticipantIps.includes(ip))

  if (!newPartyIps.includes(committeePartyIp)) {
    throw new Error(`party IP ${committeePartyIp} is not part of the new committee`)
  }
  if (isOld && !oldParticipantIps.includes(committeePartyIp)) {
    throw new Error(
      `party ${committeePartyIp} is marked old, but carry-over members must be present in both oldPartyIps and newPartyIps`,
    )
  }
  if (isNewMember && oldPartyIps.includes(committeePartyIp)) {
    throw new Error(`party ${committeePartyIp} is marked new, but fresh new members must be present in newPartyIps and absent from oldPartyIps`)
  }

  const peerAddrs: string[] = []

  for (const ip of oldParticipantIps) {
    if (ip === committeePartyIp) {
      if (isOld) {
        continue
      }
      pushUniqueAddr(peerAddrs, getOldPeerAddr(ip, chainId))
      continue
    }
    pushUniqueAddr(peerAddrs, getOldPeerAddr(ip, chainId))
  }

  for (const ip of oldAndNewIps) {
    if (ip === committeePartyIp) {
      if (isOld) {
        pushUniqueAddr(peerAddrs, getNewPeerAddr(ip, chainId))
      }
      continue
    }
    pushUniqueAddr(peerAddrs, getNewPeerAddr(ip, chainId))
  }

  for (const ip of newOnlyIps) {
    if (ip === committeePartyIp) {
      continue
    }
    pushUniqueAddr(peerAddrs, getOldPeerAddr(ip, chainId))
  }

  const expectedCount = oldThreshold + newParties
  if (peerAddrs.length !== expectedCount) {
    throw new Error(
      `Derived ${peerAddrs.length} ordered regroup peer addrs for party ${committeePartyIp}, expected ${expectedCount}.`,
    )
  }

  return peerAddrs
}

export type RegroupPartyIndexResolution = {
  partyIp: string
  source: 'local' | 'external'
  committeePosition: number
}

export async function resolveRegroupPartyIndex(
  config: RegroupCeremonyConfig,
): Promise<RegroupPartyIndexResolution & {detectedLocalIps: string[]; detectedExternalIps: string[]; attemptedExternalLookup: boolean}> {
  const detectedLocalIps = listLocalExternalIpv4s()
  let attemptedExternalLookup = false
  let detectedExternalIps: string[] = []
  let resolution

  try {
    resolution = resolvePartyIndexFromCandidates(config.newPartyIps, detectedLocalIps)
  } catch {
    attemptedExternalLookup = true
    detectedExternalIps = await lookupExternalIpv4s()
    resolution = resolvePartyIndexFromCandidates(config.newPartyIps, detectedLocalIps, detectedExternalIps)
  }

  const partyIp = config.newPartyIps[resolution.partyIdx - 1]
  const committeePosition = config.newPartyIps.indexOf(partyIp) + 1

  return {
    partyIp,
    source: resolution.source,
    committeePosition,
    detectedLocalIps,
    detectedExternalIps,
    attemptedExternalLookup,
  }
}

export function deriveRegroupCeremonyConfig(
  config: RegroupCeremonyConfig,
  committeePartyIp: string,
): RegroupCeremonyDerivedConfig {
  const newParties = config.newPartyIps.length
  const committeePosition = config.newPartyIps.indexOf(committeePartyIp) + 1
  if (!Number.isInteger(committeePosition) || committeePosition < 1 || committeePosition > newParties) {
    throw new Error(`committeePartyIp must be present in newPartyIps, received ${committeePartyIp}`)
  }

  const isOld = config.oldPartyIps.includes(committeePartyIp)
  const isNewMember = !isOld
  const newListenPort = isOld
    ? bnbTss.getDeterministicRegroupListenPort(config.chainId, bnbTss.DEFAULT_SLOT_PARTY_IDX)
    : undefined
  const newListenAddr = isOld
    ? bnbTss.getLocalRegroupListenAddr(config.chainId, bnbTss.DEFAULT_SLOT_PARTY_IDX)
    : undefined

  return {
    chainId: config.chainId,
    committeePosition,
    committeePartyIp,
    oldParties: config.oldPartyIps.length,
    newParties,
    oldThreshold: config.oldThreshold,
    newThreshold: config.newThreshold,
    isOld,
    isNewMember,
    newListenPort,
    newListenAddr,
    newPeerAddrs: deriveOrderedRegroupPeerAddrs({
      chainId: config.chainId,
      oldPartyIps: config.oldPartyIps,
      newPartyIps: config.newPartyIps,
      oldThreshold: config.oldThreshold,
      committeePartyIp,
      isOld,
      isNewMember,
    }),
  }
}

export function deriveDeterministicRegroupChannelId(
  config: RegroupCeremonyConfig,
  nonce: string,
  now = new Date(),
): string {
  const expiryHex = deriveNextUtcMidnightUnix(now).toString(16).toUpperCase().padStart(8, '0')
  const prefix = createHash('sha256').update(buildCeremonyMaterial(config, nonce)).digest('hex').slice(0, 3)
  const numericPrefix = `${Number.parseInt(prefix, 16) % 1000}`.padStart(3, '0')
  return `${numericPrefix}${expiryHex}`
}

export function deriveDeterministicRegroupChannelPassword(
  config: RegroupCeremonyConfig,
  nonce: string,
  channelId: string,
): string {
  return createHash('sha256')
    .update(`${channelId}:${buildCeremonyMaterial(config, nonce)}:channel-password`)
    .digest('hex')
}
