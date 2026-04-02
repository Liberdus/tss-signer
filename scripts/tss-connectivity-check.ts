#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
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

type FirewallState = 'active' | 'inactive' | 'unknown'

type HelloMessage = {
  type: 'hello' | 'hello-ack'
  chainId: number
  partyIdx: number
  ip: string
  port: number
}

type PeerConnectivitySnapshot = {
  party: ConnectivityParty
  inbound: boolean
  outbound: boolean
  ready: boolean
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
const CHECK_INTERVAL_MS = 5_000
const INBOUND_STALE_MS = CHECK_INTERVAL_MS * 3

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

function abortError(): Error {
  return new Error('connectivity check aborted')
}

function formatClock(timestamp = Date.now()): string {
  const date = new Date(timestamp)
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')
  const seconds = `${date.getSeconds()}`.padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
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

function formatStatusMark(connected: boolean): string {
  return connected ? 'OK' : 'X'
}

function buildStatusTable(snapshot: PeerConnectivitySnapshot[]): string[] {
  const rows = snapshot.map(({party, inbound, outbound, ready}) => [
    String(party.partyIdx),
    `${party.ip}:${party.port}`,
    formatStatusMark(inbound),
    formatStatusMark(outbound),
    formatStatusMark(ready),
  ])

  const headers = ['Party', 'Address', 'In', 'Out', 'Ready']
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  )

  const formatRow = (row: string[]): string => row.map((cell, index) => cell.padEnd(widths[index])).join('  ')
  const separator = widths.map((width) => '-'.repeat(width)).join('  ')

  return [
    formatRow(headers),
    separator,
    ...rows.map((row) => formatRow(row)),
  ]
}

function buildStatusLines(tracker: ConnectivityTracker, statusLine: string): string[] {
  const snapshot = tracker.getSnapshot()
  return [
    'Connectivity status:',
    ...buildStatusTable(snapshot).map((line) => `  ${line}`),
    `Overall: ${formatStatusMark(tracker.hasPassed())} ${tracker.readyCount()}/${snapshot.length} peers ready`,
    statusLine,
  ]
}

async function waitForInterval(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now()
  while (!signal?.aborted && Date.now() - startedAt < timeoutMs) {
    await delay(100)
  }
}

export class ConnectivityTracker {
  private readonly lastInboundAt = new Map<number, number>()
  private readonly outboundConnected = new Set<number>()

  constructor(
    private readonly peers: ConnectivityParty[],
    private readonly now: () => number = () => Date.now(),
    private readonly inboundStaleMs = INBOUND_STALE_MS,
  ) {
  }

  markInbound(party: ConnectivityParty): boolean {
    const wasConnected = this.hasFreshInbound(party.partyIdx)
    this.lastInboundAt.set(party.partyIdx, this.now())
    return !wasConnected
  }

  markOutbound(party: ConnectivityParty): boolean {
    const wasConnected = this.outboundConnected.has(party.partyIdx)
    this.outboundConnected.add(party.partyIdx)
    return !wasConnected
  }

  markOutboundFailure(party: ConnectivityParty): boolean {
    return this.outboundConnected.delete(party.partyIdx)
  }

  getSnapshot(): PeerConnectivitySnapshot[] {
    return this.peers.map((party) => {
      const inbound = this.hasFreshInbound(party.partyIdx)
      const outbound = this.outboundConnected.has(party.partyIdx)
      return {
        party,
        inbound,
        outbound,
        ready: inbound && outbound,
      }
    })
  }

  readyCount(): number {
    return this.getSnapshot().filter((entry) => entry.ready).length
  }

  hasPassed(): boolean {
    return this.getSnapshot().every((entry) => entry.ready)
  }

  printStatus(statusLine = `Last updated: ${formatClock(this.now())}`): number {
    for (const line of buildStatusLines(this, statusLine)) {
      console.log(line)
    }
    return this.hasPassed() ? 0 : 1
  }

  private hasFreshInbound(partyIdx: number): boolean {
    const lastSeenAt = this.lastInboundAt.get(partyIdx)
    return lastSeenAt !== undefined && this.now() - lastSeenAt <= this.inboundStaleMs
  }
}

class LiveStatusRenderer {
  private renderedLines = 0
  private pending = false
  private statusLine = `Last updated: ${formatClock()}`

  constructor(
    private readonly tracker: ConnectivityTracker,
    private readonly stream: NodeJS.WriteStream = process.stdout,
  ) {
  }

  render(statusLine = this.statusLine, forcePrint = false): void {
    this.statusLine = statusLine
    const lines = buildStatusLines(this.tracker, this.statusLine)

    if (this.stream.isTTY) {
      if (this.renderedLines > 0) {
        this.stream.write(`\u001b[${this.renderedLines}F`)
      }
      for (const line of lines) {
        this.stream.write('\u001b[2K')
        this.stream.write(`${line}\n`)
      }
      this.renderedLines = lines.length
      return
    }

    if (forcePrint || this.renderedLines === 0) {
      for (const line of lines) {
        console.log(line)
      }
      this.renderedLines = lines.length
    }
  }

  requestRender(statusLine?: string): void {
    if (!this.stream.isTTY) {
      return
    }

    if (statusLine) {
      this.statusLine = statusLine
    }
    if (this.pending) {
      return
    }

    this.pending = true
    setImmediate(() => {
      this.pending = false
      this.render(this.statusLine)
    })
  }
}

function buildStatusLine(): string {
  return `Last updated: ${formatClock()} | Rechecking every ${Math.floor(CHECK_INTERVAL_MS / 1000)} seconds | Press Ctrl+C to stop`
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
  console.log(`  check interval: ${Math.floor(CHECK_INTERVAL_MS / 1000)} seconds`)
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

function logPortInUseHelp(port: number): void {
  console.error(`Port ${port} is already in use.`)
  console.error('Copy and paste this to stop a stale connectivity check and free the port:')
  console.error(`  pkill -f 'node dist/scripts/tss-connectivity-check.js' || true`)
  console.error('Then run the connectivity check again.')
}

function isPortInUseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const errno = error as NodeJS.ErrnoException
  return errno.code === 'EADDRINUSE' || errno.message?.includes('EADDRINUSE') === true
}

async function closeServer(server: net.Server, sockets: Set<net.Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy()
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

function createInboundServer(
  chainId: number,
  localParty: ConnectivityParty,
  peersByPartyIdx: Map<number, ConnectivityParty>,
  tracker: ConnectivityTracker,
  sockets: Set<net.Socket>,
  onStateChange: () => void,
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
      socket.destroy()
    }

    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    socket.on('close', () => {
      sockets.delete(socket)
    })

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

        if (tracker.markInbound(peer)) {
          onStateChange()
        }
        socket.end(ackMessage)
      } catch {
        cleanup()
      }
    })

    socket.on('timeout', cleanup)
    socket.on('error', cleanup)
  })
}

async function connectToPeer(
  peer: ConnectivityParty,
  localHello: HelloMessage,
  chainId: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    const socket = net.createConnection({host: peer.ip, port: peer.port})
    let settled = false
    let buffer = ''

    const finish = (error?: Error) => {
      if (settled) {
        return
      }

      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.removeAllListeners()
      socket.destroy()

      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const onAbort = () => finish(abortError())

    socket.setEncoding('utf8')
    socket.setTimeout(CONNECT_TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort, {once: true})

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
  onStateChange: () => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await connectToPeer(peer, localHello, chainId, signal)
    if (tracker.markOutbound(peer)) {
      onStateChange()
    }
  } catch {
    if (signal?.aborted) {
      return
    }
    if (tracker.markOutboundFailure(peer)) {
      onStateChange()
    }
  }
}

export async function runConnectivityCycle(
  check: ResolvedConnectivityCheck,
  tracker: ConnectivityTracker,
  onStateChange: () => void,
  signal?: AbortSignal,
): Promise<number> {
  const localHello: HelloMessage = {
    type: 'hello',
    chainId: check.config.chainId,
    partyIdx: check.localParty.partyIdx,
    ip: check.localParty.ip,
    port: check.localParty.port,
  }

  const outboundTasks = check.peers.map((peer) =>
    connectOnce(peer, localHello, check.config.chainId, tracker, onStateChange, signal),
  )
  await Promise.allSettled(outboundTasks)
  return tracker.hasPassed() ? 0 : 1
}

export async function main(): Promise<void> {
  const check = await resolveConnectivityCheck(parseArgs(process.argv.slice(2)))
  logResolvedConnectivityCheck(check)
  const tracker = new ConnectivityTracker(check.peers)
  const renderer = new LiveStatusRenderer(tracker)
  const peersByPartyIdx = new Map(check.peers.map((peer) => [peer.partyIdx, peer]))
  const sockets = new Set<net.Socket>()
  const shutdownController = new AbortController()
  let stopRequested = false

  const requestRender = () => {
    renderer.requestRender(buildStatusLine())
  }

  const server = createInboundServer(
    check.config.chainId,
    check.localParty,
    peersByPartyIdx,
    tracker,
    sockets,
    requestRender,
  )

  const requestStop = () => {
    if (stopRequested) {
      return
    }

    stopRequested = true
    console.log('\nStopping connectivity check...')
    shutdownController.abort()
  }

  process.once('SIGINT', requestStop)
  process.once('SIGTERM', requestStop)
  try {
    await waitForServerListening(server, check.localParty.port)
  } catch (error) {
    if (isPortInUseError(error)) {
      logPortInUseHelp(check.localParty.port)
      process.exitCode = 1
      return
    }
    throw error
  }

  console.log(`Listening on 0.0.0.0:${check.localParty.port}`)
  console.log('This check keeps running until you stop it.')
  console.log(`Rechecking every ${Math.floor(CHECK_INTERVAL_MS / 1000)} seconds.`)
  console.log('Press Ctrl+C to stop.')

  renderer.render(buildStatusLine(), true)

  let exitCode = 1

  try {
    while (!shutdownController.signal.aborted) {
      exitCode = await runConnectivityCycle(check, tracker, requestRender, shutdownController.signal)
      renderer.render(buildStatusLine(), !process.stdout.isTTY)
      await waitForInterval(CHECK_INTERVAL_MS, shutdownController.signal)
    }
  } finally {
    process.off('SIGINT', requestStop)
    process.off('SIGTERM', requestStop)
    await closeServer(server, sockets)
  }

  process.exitCode = stopRequested ? 0 : exitCode
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
