#!/usr/bin/env node
import net from 'node:net'
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
  localParty: ConnectivityParty
  peers: ConnectivityParty[]
}

const DEFAULT_TOTAL_TIMEOUT_MS = 120_000
const CONNECT_TIMEOUT_MS = 5_000
const RETRY_DELAY_MS = 2_000

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
  readonly result: Promise<number>

  private finished = false
  private readonly resolveResult: (exitCode: number) => void

  constructor(private readonly peers: ConnectivityParty[]) {
    let resolver: (exitCode: number) => void = () => undefined
    this.result = new Promise<number>((resolve) => {
      resolver = resolve
    })
    this.resolveResult = resolver
  }

  isFinished(): boolean {
    return this.finished
  }

  markInbound(party: ConnectivityParty): void {
    if (this.inboundConnected.has(party.partyIdx)) {
      return
    }
    this.inboundConnected.add(party.partyIdx)
    console.log(`Party ${party.partyIdx} connected to you from ${party.ip}:${party.port}`)
    this.maybeFinish()
  }

  markOutbound(party: ConnectivityParty): void {
    if (this.outboundConnected.has(party.partyIdx)) {
      return
    }
    this.outboundConnected.add(party.partyIdx)
    console.log(`You connected to party ${party.partyIdx} at ${party.ip}:${party.port}`)
    this.maybeFinish()
  }

  finishTimeout(): void {
    if (this.finished) {
      return
    }

    this.finished = true
    console.log(`Connectivity check timed out after ${Math.floor(DEFAULT_TOTAL_TIMEOUT_MS / 1000)} seconds.`)
    this.printSummary()
    summarizeMissing('Still waiting for these parties to connect to you:', this.peers, this.inboundConnected)
    summarizeMissing('You could not connect to these parties:', this.peers, this.outboundConnected)
    this.resolveResult(1)
  }

  private maybeFinish(): void {
    if (this.finished) {
      return
    }

    if (this.inboundConnected.size !== this.peers.length || this.outboundConnected.size !== this.peers.length) {
      return
    }

    this.finished = true
    console.log('Connectivity check passed.')
    this.printSummary()
    this.resolveResult(0)
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
  console.log(`  party index source: ${check.resolution.source}`)
  console.log(`  matched party IP: ${check.localParty.ip}`)
  console.log(`  listen port: ${check.localParty.port}`)
  console.log(`  timeout: ${Math.floor(DEFAULT_TOTAL_TIMEOUT_MS / 1000)} seconds`)
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

async function connectUntilSuccess(
  peer: ConnectivityParty,
  localHello: HelloMessage,
  chainId: number,
  tracker: ConnectivityTracker,
): Promise<void> {
  while (!tracker.isFinished() && !tracker.outboundConnected.has(peer.partyIdx)) {
    try {
      await connectToPeer(peer, localHello, chainId)
      tracker.markOutbound(peer)
      return
    } catch {
      if (tracker.isFinished()) {
        return
      }
      await delay(RETRY_DELAY_MS)
    }
  }
}

export async function main(): Promise<void> {
  const check = await resolveConnectivityCheck(parseArgs(process.argv.slice(2)))
  const tracker = new ConnectivityTracker(check.peers)
  const peersByPartyIdx = new Map(check.peers.map((peer) => [peer.partyIdx, peer]))
  const localHello: HelloMessage = {
    type: 'hello',
    chainId: check.config.chainId,
    partyIdx: check.localParty.partyIdx,
    ip: check.localParty.ip,
    port: check.localParty.port,
  }

  logResolvedConnectivityCheck(check)

  const server = createInboundServer(check.config.chainId, check.localParty, peersByPartyIdx, tracker)
  await waitForServerListening(server, check.localParty.port)

  console.log(`Listening on 0.0.0.0:${check.localParty.port}`)
  console.log(`Waiting up to ${Math.floor(DEFAULT_TOTAL_TIMEOUT_MS / 1000)} seconds.`)

  const timeoutHandle = setTimeout(() => tracker.finishTimeout(), DEFAULT_TOTAL_TIMEOUT_MS)
  const outboundTasks = check.peers.map((peer) => connectUntilSuccess(peer, localHello, check.config.chainId, tracker))

  const exitCode = await tracker.result
  clearTimeout(timeoutHandle)

  await Promise.allSettled(outboundTasks)
  await closeServer(server)
  process.exit(exitCode)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
