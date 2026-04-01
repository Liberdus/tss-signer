#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
import net from 'node:net'
import {createInterface} from 'node:readline/promises'
import * as keygenCeremony from '../tss-tools/lib/keygenCeremony'
import {resolveProjectRoot} from '../shared/utils/paths'

type Options = {
  configPath?: string
  port?: number
}

type ConnectivityParty = {
  partyIdx: number
  ip: string
  port: number
}

type FirewallState = 'active' | 'inactive' | 'unknown'

type HelloMessage = {
  type: 'hello' | 'hello-ack'
  chainId: number
  partyIdx: number
  ip: string
  port: number
}

type ResolvedConnectivityCheck = {
  resolvedConfigPath: string
  config: keygenCeremony.KeygenCeremonyConfig
  resolution: keygenCeremony.PartyIndexResolution
  detectedLocalIps: string[]
  detectedExternalIps: string[]
  attemptedExternalLookup: boolean
  firewallState: FirewallState
  localParty: ConnectivityParty
  peers: ConnectivityParty[]
}

const CONNECT_TIMEOUT_MS = 5_000
const ROUND_START_DELAY_MS = 5_000
const ROUND_WINDOW_MS = 10_000

function usage(exitCode = 1): never {
  console.error('Usage: node scripts/tss-connectivity-check.js [--config <path>] [--port <number>]')
  process.exit(exitCode)
}

export function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]

    switch (arg) {
      case '--config':
        options.configPath = value
        i += 1
        break
      case '--port': {
        const parsed = Number.parseInt(value, 10)
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
          console.error(`Invalid port: ${value}`)
          usage()
        }
        options.port = parsed
        i += 1
        break
      }
      case '-h':
      case '--help':
        usage(0)
        break
      default:
        console.error(`Unknown argument: ${arg}`)
        usage()
    }
  }

  return options as Options
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readCommandOutput(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, {encoding: 'utf8'})
  if (result.error) {
    return null
  }
  return `${result.stdout}${result.stderr}`.trim().toLowerCase()
}

export function detectFirewallState(): FirewallState {
  if (process.platform !== 'linux') {
    return 'unknown'
  }

  const systemctlStatus = readCommandOutput('systemctl', ['is-active', 'ufw'])
  if (systemctlStatus === 'active' || systemctlStatus === 'activating' || systemctlStatus === 'reloading') {
    return 'active'
  }
  if (
    systemctlStatus === 'inactive' ||
    systemctlStatus === 'failed' ||
    systemctlStatus === 'deactivating' ||
    systemctlStatus === 'unknown'
  ) {
    return 'inactive'
  }

  const ufwStatus = readCommandOutput('ufw', ['status'])
  if (ufwStatus?.includes('status: active')) {
    return 'active'
  }
  if (ufwStatus?.includes('status: inactive')) {
    return 'inactive'
  }

  return 'unknown'
}

function readFirstLine(buffer: string): string | null {
  const newlineIndex = buffer.indexOf('\n')
  if (newlineIndex < 0) {
    return null
  }
  return buffer.slice(0, newlineIndex).trim()
}

export function formatParty(party: ConnectivityParty): string {
  return `party ${party.partyIdx} (${party.ip}:${party.port})`
}

export function buildHelloMessage(message: HelloMessage): string {
  return `${JSON.stringify(message)}\n`
}

export function parseHelloMessage(raw: string): HelloMessage {
  const parsed = JSON.parse(raw) as Partial<HelloMessage>
  if (
    (parsed.type !== 'hello' && parsed.type !== 'hello-ack') ||
    !Number.isInteger(parsed.chainId) ||
    !Number.isInteger(parsed.partyIdx) ||
    typeof parsed.ip !== 'string' ||
    !Number.isInteger(parsed.port)
  ) {
    throw new Error('invalid handshake payload')
  }
  return parsed as HelloMessage
}

export function buildPeers(partyIps: string[], localPartyIdx: number, port: number): ConnectivityParty[] {
  return partyIps.flatMap((ip, index) => {
    const partyIdx = index + 1
    if (partyIdx === localPartyIdx) {
      return []
    }
    return [{partyIdx, ip, port}]
  })
}

function summarizeMissing(heading: string, peers: ConnectivityParty[], connected: Set<number>): void {
  const missing = peers.filter((peer) => !connected.has(peer.partyIdx))
  if (missing.length === 0) {
    return
  }

  console.log(heading)
  for (const peer of missing) {
    console.log(`  - ${formatParty(peer)}`)
  }
}

export class ConnectivityTracker {
  readonly inboundConnected = new Set<number>()
  readonly outboundConnected = new Set<number>()

  constructor(private readonly peers: ConnectivityParty[]) {
  }

  markInbound(party: ConnectivityParty): void {
    if (this.inboundConnected.has(party.partyIdx)) {
      return
    }
    this.inboundConnected.add(party.partyIdx)
    console.log(`Party ${party.partyIdx} connected to you from ${party.ip}:${party.port}`)
  }

  markOutbound(party: ConnectivityParty): void {
    if (this.outboundConnected.has(party.partyIdx)) {
      return
    }
    this.outboundConnected.add(party.partyIdx)
    console.log(`You connected to party ${party.partyIdx} at ${party.ip}:${party.port}`)
  }

  hasPassed(): boolean {
    return this.inboundConnected.size === this.peers.length && this.outboundConnected.size === this.peers.length
  }

  printRoundSummary(): number {
    if (this.hasPassed()) {
      console.log('Connectivity check passed.')
    } else {
      console.log('Connectivity check did not pass.')
    }
    this.printSummary()
    summarizeMissing('Still waiting for these parties to connect to you:', this.peers, this.inboundConnected)
    summarizeMissing('You could not connect to these parties:', this.peers, this.outboundConnected)
    return this.hasPassed() ? 0 : 1
  }

  private printSummary(): void {
    console.log(`  Outbound connections succeeded: ${this.outboundConnected.size}/${this.peers.length}`)
    console.log(`  Inbound connections received: ${this.inboundConnected.size}/${this.peers.length}`)
  }
}

export async function resolveConnectivityCheck(options: Options): Promise<ResolvedConnectivityCheck> {
  const signerRoot = resolveProjectRoot()
  const resolvedConfigPath = keygenCeremony.resolveKeygenCeremonyConfigPath(options.configPath, signerRoot)
  const config = keygenCeremony.loadKeygenCeremonyConfig(options.configPath, signerRoot)
  const detectedLocalIps = keygenCeremony.listLocalExternalIpv4s()

  let attemptedExternalLookup = false
  let detectedExternalIps: string[] = []
  let resolution: keygenCeremony.PartyIndexResolution

  try {
    resolution = keygenCeremony.resolvePartyIndexFromCandidates(config.partyIps, detectedLocalIps)
  } catch (error) {
    const localErrorMessage = error instanceof Error ? error.message : String(error)
    attemptedExternalLookup = true
    detectedExternalIps = await keygenCeremony.lookupExternalIpv4s()
    if (detectedExternalIps.length === 0) {
      console.warn('External IPv4 lookup did not return any usable IPv4 address.')
    }
    resolution = keygenCeremony.resolvePartyIndexFromCandidates(config.partyIps, detectedLocalIps, detectedExternalIps)
    if (resolution.source === 'external') {
      console.warn(`Local IPv4 auto-detection did not resolve the party index: ${localErrorMessage}`)
      console.warn('Falling back to external IPv4 lookup results.')
    }
  }

  const derived = keygenCeremony.deriveKeygenCeremonyConfig(config, resolution.partyIdx)
  const listenPort = options.port ?? derived.listenPort
  const localParty: ConnectivityParty = {
    partyIdx: derived.committeePosition,
    ip: derived.committeePartyIp,
    port: listenPort,
  }

  return {
    resolvedConfigPath,
    config,
    resolution,
    detectedLocalIps,
    detectedExternalIps,
    attemptedExternalLookup,
    firewallState: detectFirewallState(),
    localParty,
    peers: buildPeers(config.partyIps, derived.committeePosition, listenPort),
  }
}

export function logResolvedConnectivityCheck(check: ResolvedConnectivityCheck): void {
  console.log('Resolved connectivity check:')
  console.log(`  config: ${check.resolvedConfigPath}`)
  console.log(`  chain id: ${check.config.chainId}`)
  console.log(`  committee position: ${check.localParty.partyIdx}`)
  console.log(
    `  detected local IPv4s: ${check.detectedLocalIps.length > 0 ? check.detectedLocalIps.join(', ') : '(none detected)'}`,
  )
  console.log(
    `  detected external IPv4s: ${
      check.detectedExternalIps.length > 0
        ? check.detectedExternalIps.join(', ')
        : check.attemptedExternalLookup
          ? '(none resolved)'
          : '(not needed)'
    }`,
  )
  console.log(`  firewall (ufw): ${check.firewallState}`)
  console.log(`  party index source: ${check.resolution.source}`)
  console.log(`  matched party IP: ${check.localParty.ip}`)
  console.log(`  listen port: ${check.localParty.port}`)
  console.log(`  round window: ${Math.floor(ROUND_WINDOW_MS / 1000)} seconds`)
  console.log(`  peers to check (${check.peers.length}):`)
  for (const peer of check.peers) {
    console.log(`    party ${peer.partyIdx}: ${peer.ip}:${peer.port}`)
  }
}

async function waitForServerListening(server: net.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }

    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '0.0.0.0')
  })
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

function createInboundServer(
  chainId: number,
  localParty: ConnectivityParty,
  peersByPartyIdx: Map<number, ConnectivityParty>,
  tracker: ConnectivityTracker,
): net.Server {
  const ackMessage = buildHelloMessage({
    type: 'hello-ack',
    chainId,
    partyIdx: localParty.partyIdx,
    ip: localParty.ip,
    port: localParty.port,
  })

  return net.createServer((socket) => {
    let buffer = ''
    let handled = false

    const cleanup = () => {
      socket.removeAllListeners()
      socket.destroy()
    }

    socket.setEncoding('utf8')
    socket.setTimeout(CONNECT_TIMEOUT_MS)

    socket.on('data', (chunk: string) => {
      if (handled) {
        return
      }

      buffer += chunk
      const line = readFirstLine(buffer)
      if (line === null) {
        return
      }

      handled = true

      try {
        const hello = parseHelloMessage(line)
        const peer = peersByPartyIdx.get(hello.partyIdx)
        if (hello.type !== 'hello' || hello.chainId !== chainId || !peer) {
          cleanup()
          return
        }

        tracker.markInbound(peer)
        socket.end(ackMessage)
      } catch {
        cleanup()
      }
    })

    socket.on('timeout', cleanup)
    socket.on('error', cleanup)
  })
}

async function connectToPeer(peer: ConnectivityParty, localHello: HelloMessage, chainId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({host: peer.ip, port: peer.port})
    let settled = false
    let buffer = ''

    const finish = (error?: Error) => {
      if (settled) {
        return
      }

      settled = true
      socket.removeAllListeners()
      socket.destroy()

      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    socket.setEncoding('utf8')
    socket.setTimeout(CONNECT_TIMEOUT_MS)

    socket.on('connect', () => {
      socket.write(buildHelloMessage(localHello))
    })

    socket.on('data', (chunk: string) => {
      buffer += chunk
      const line = readFirstLine(buffer)
      if (line === null) {
        return
      }

      try {
        const response = parseHelloMessage(line)
        if (response.type !== 'hello-ack') {
          finish(new Error('unexpected handshake response'))
          return
        }
        if (response.chainId !== chainId) {
          finish(new Error(`unexpected chain id ${response.chainId}`))
          return
        }
        if (response.partyIdx !== peer.partyIdx) {
          finish(new Error(`expected party ${peer.partyIdx}, got party ${response.partyIdx}`))
          return
        }
        finish()
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })

    socket.on('timeout', () => finish(new Error('connection timed out')))
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error('connection closed before handshake completed')))
  })
}

async function connectOnce(
  peer: ConnectivityParty,
  localHello: HelloMessage,
  chainId: number,
  tracker: ConnectivityTracker,
): Promise<void> {
  try {
    await connectToPeer(peer, localHello, chainId)
    tracker.markOutbound(peer)
  } catch {
    return
  }
}

export async function runConnectivityRound(check: ResolvedConnectivityCheck): Promise<number> {
  const tracker = new ConnectivityTracker(check.peers)
  const peersByPartyIdx = new Map(check.peers.map((peer) => [peer.partyIdx, peer]))
  const localHello: HelloMessage = {
    type: 'hello',
    chainId: check.config.chainId,
    partyIdx: check.localParty.partyIdx,
    ip: check.localParty.ip,
    port: check.localParty.port,
  }

  const server = createInboundServer(check.config.chainId, check.localParty, peersByPartyIdx, tracker)
  await waitForServerListening(server, check.localParty.port)

  console.log(`Listening on 0.0.0.0:${check.localParty.port}`)
  console.log(`Waiting up to ${Math.floor(ROUND_WINDOW_MS / 1000)} seconds for this round.`)

  const roundStartedAt = Date.now()
  await delay(ROUND_START_DELAY_MS)
  const outboundTasks = check.peers.map((peer) => connectOnce(peer, localHello, check.config.chainId, tracker))
  await Promise.allSettled(outboundTasks)

  if (!tracker.hasPassed()) {
    const remainingMs = Math.max(0, ROUND_WINDOW_MS - (Date.now() - roundStartedAt))
    if (remainingMs > 0) {
      await delay(remainingMs)
    }
  }

  await closeServer(server)
  return tracker.printRoundSummary()
}

async function promptToRunAgain(): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    const answer = (await rl.question('Run connectivity check again? [y/N]: ')).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

export async function main(): Promise<void> {
  const check = await resolveConnectivityCheck(parseArgs(process.argv.slice(2)))
  logResolvedConnectivityCheck(check)

  let exitCode = 1
  let roundNumber = 1

  while (true) {
    if (roundNumber > 1) {
      console.log(`Starting connectivity check round ${roundNumber}.`)
    }

    exitCode = await runConnectivityRound(check)
    roundNumber += 1

    if (!(await promptToRunAgain())) {
      process.exit(exitCode)
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
