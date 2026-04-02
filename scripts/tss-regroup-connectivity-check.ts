#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
import net from 'node:net'
import * as bnbTss from '../tss-tools/lib/bnbTss'
import * as regroupCeremony from '../tss-tools/lib/regroupCeremony'
import {resolveProjectRoot} from '../shared/utils/paths'

type Options = {
  configPath?: string
  port?: number
}

type FirewallState = 'active' | 'inactive' | 'unknown'
type EndpointKind = 'base' | 'regroup'

type RegroupConnectivityParty = {
  partyIdx: number
  ip: string
  basePort: number
  regroupPort?: number
  isActiveOld: boolean
}

type HelloMessage = {
  type: 'hello' | 'hello-ack'
  chainId: number
  partyIdx: number
  endpoint: EndpointKind
}

type PeerConnectivitySnapshot = {
  party: RegroupConnectivityParty
  baseInbound: boolean
  baseOutbound: boolean
  regroupInbound?: boolean
  regroupOutbound?: boolean
  ready: boolean
}

type ResolvedRegroupConnectivityCheck = {
  resolvedConfigPath: string
  config: regroupCeremony.RegroupCeremonyConfig
  resolution: regroupCeremony.RegroupPartyIndexResolution
  detectedLocalIps: string[]
  detectedExternalIps: string[]
  attemptedExternalLookup: boolean
  firewallState: FirewallState
  activeOldPartyIps: string[]
  basePort: number
  regroupPort: number
  localParty: RegroupConnectivityParty
  peers: RegroupConnectivityParty[]
}

const CONNECT_TIMEOUT_MS = 5_000
const CHECK_INTERVAL_MS = 5_000
const INBOUND_STALE_MS = CHECK_INTERVAL_MS * 3
const REGROUP_PORT_OFFSET = 1000
const ANSI_RESET = '\u001b[0m'
const ANSI_GREEN = '\u001b[32m'
const ANSI_RED = '\u001b[31m'
const ANSI_GRAY = '\u001b[90m'

function usage(exitCode = 1): never {
  console.error('Usage: node scripts/tss-regroup-connectivity-check.js [--config <path>] [--port <number>]')
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
  return new Error('regroup connectivity check aborted')
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
    (parsed.endpoint !== 'base' && parsed.endpoint !== 'regroup')
  ) {
    throw new Error('invalid handshake payload')
  }
  return parsed as HelloMessage
}

function getRegroupPort(basePort: number): number {
  return basePort + REGROUP_PORT_OFFSET
}

function buildPeerPortsLabel(party: RegroupConnectivityParty): string {
  if (party.regroupPort === undefined) {
    return `${party.basePort}`
  }
  return `${party.basePort},${party.regroupPort}`
}

function endpointKey(partyIdx: number, endpoint: EndpointKind): string {
  return `${partyIdx}:${endpoint}`
}

export function buildRegroupParties(
  config: regroupCeremony.RegroupCeremonyConfig,
  basePort: number,
): {activeOldPartyIps: string[]; parties: RegroupConnectivityParty[]} {
  const activeOldPartyIps = config.oldPartyIps.slice(0, config.oldThreshold + 1)
  const uniqueIps = [...new Set([...config.oldPartyIps, ...config.newPartyIps])]
  const regroupPort = getRegroupPort(basePort)

  const parties = uniqueIps.map((ip) => {
    const partyIdx = config.newPartyIps.indexOf(ip) + 1
    if (partyIdx < 1) {
      throw new Error(
        `Regroup connectivity check only supports the ceremony-wrapper topology where every oldPartyIp also appears in newPartyIps. Missing from newPartyIps: ${ip}`,
      )
    }

    const isActiveOld = activeOldPartyIps.includes(ip)
    return {
      partyIdx,
      ip,
      basePort,
      regroupPort: isActiveOld ? regroupPort : undefined,
      isActiveOld,
    }
  })

  parties.sort((left, right) => left.partyIdx - right.partyIdx)
  return {activeOldPartyIps, parties}
}

function formatStatusMark(connected?: boolean): string {
  if (connected === undefined) {
    return 'n/a'
  }
  return connected ? 'OK' : 'X'
}

function colorForStatus(connected?: boolean): string | null {
  if (connected === undefined) {
    return ANSI_GRAY
  }
  return connected ? ANSI_GREEN : ANSI_RED
}

function buildStatusTable(
  snapshot: PeerConnectivitySnapshot[],
  basePort: number,
  regroupPort: number,
  useColor: boolean,
): string[] {
  const rows = snapshot.map(({party, baseInbound, baseOutbound, regroupInbound, regroupOutbound, ready}) => ({
    raw: [
      String(party.partyIdx),
      party.ip,
      buildPeerPortsLabel(party),
      formatStatusMark(baseInbound),
      formatStatusMark(baseOutbound),
      formatStatusMark(regroupInbound),
      formatStatusMark(regroupOutbound),
      formatStatusMark(ready),
    ],
    statuses: [baseInbound, baseOutbound, regroupInbound, regroupOutbound, ready],
    ready,
  }))

  const headers = [
    'Party',
    'Address',
    'Ports',
    `${basePort} In`,
    `${basePort} Out`,
    `${regroupPort} In`,
    `${regroupPort} Out`,
    'Ready',
  ]
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row.raw[index].length)))

  const formatRow = (row: (typeof rows)[number]): string => {
    const padded = row.raw.map((cell, index) => cell.padEnd(widths[index]))
    if (row.ready) {
      return colorize(padded.join('  '), ANSI_GREEN, useColor)
    }
    const rendered = padded.map((cell, index) => {
      if (index < 3) {
        return cell
      }
      const status = row.statuses[index - 3]
      const color = colorForStatus(status)
      return color ? colorize(cell, color, useColor) : cell
    })
    return rendered.join('  ')
  }
  const separator = widths.map((width) => '-'.repeat(width)).join('  ')

  return [
    headers.map((cell, index) => cell.padEnd(widths[index])).join('  '),
    separator,
    ...rows.map((row) => formatRow(row)),
  ]
}

function buildStatusLines(tracker: RegroupConnectivityTracker, statusLine: string): string[] {
  const snapshot = tracker.getSnapshot()
  const {basePort, regroupPort} = tracker.getDisplayPorts()
  const readyCount = tracker.readyCount()
  const totalPeers = snapshot.length
  const useColor = Boolean(process.stdout.isTTY)
  const overallLine = tracker.hasPassed()
    ? colorize(`✓ ALL REQUIRED PEERS READY (${readyCount}/${totalPeers})`, ANSI_GREEN, useColor)
    : colorize(`✗ NOT READY YET (${readyCount}/${totalPeers} peers ready)`, ANSI_RED, useColor)
  return [
    'Regroup connectivity status:',
    'Legend:',
    `  In = peer connected to your port`,
    `  Out = you connected to the peer's port`,
    `  n/a = not required`,
    ...buildStatusTable(snapshot, basePort, regroupPort, useColor).map((line) => `  ${line}`),
    overallLine,
    statusLine,
  ]
}

async function waitForInterval(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now()
  while (!signal?.aborted && Date.now() - startedAt < timeoutMs) {
    await delay(100)
  }
}

export class RegroupConnectivityTracker {
  private readonly lastInboundAt = new Map<string, number>()
  private readonly outboundConnected = new Set<string>()

  constructor(
    private readonly localParty: RegroupConnectivityParty,
    private readonly peers: RegroupConnectivityParty[],
    private readonly now: () => number = () => Date.now(),
    private readonly inboundStaleMs = INBOUND_STALE_MS,
  ) {
  }

  markInbound(party: RegroupConnectivityParty, endpoint: EndpointKind): boolean {
    const key = endpointKey(party.partyIdx, endpoint)
    const wasConnected = this.hasFreshInbound(key)
    this.lastInboundAt.set(key, this.now())
    return !wasConnected
  }

  markOutbound(party: RegroupConnectivityParty, endpoint: EndpointKind): boolean {
    const key = endpointKey(party.partyIdx, endpoint)
    const wasConnected = this.outboundConnected.has(key)
    this.outboundConnected.add(key)
    return !wasConnected
  }

  markOutboundFailure(party: RegroupConnectivityParty, endpoint: EndpointKind): boolean {
    return this.outboundConnected.delete(endpointKey(party.partyIdx, endpoint))
  }

  getSnapshot(): PeerConnectivitySnapshot[] {
    return this.peers.map((party) => {
      const baseInbound = this.hasFreshInbound(endpointKey(party.partyIdx, 'base'))
      const baseOutbound = this.outboundConnected.has(endpointKey(party.partyIdx, 'base'))
      const regroupInbound = this.localParty.isActiveOld
        ? this.hasFreshInbound(endpointKey(party.partyIdx, 'regroup'))
        : undefined
      const regroupOutbound = party.isActiveOld
        ? this.outboundConnected.has(endpointKey(party.partyIdx, 'regroup'))
        : undefined
      const ready =
        baseInbound &&
        baseOutbound &&
        (regroupInbound === undefined || regroupInbound) &&
        (regroupOutbound === undefined || regroupOutbound)

      return {
        party,
        baseInbound,
        baseOutbound,
        regroupInbound,
        regroupOutbound,
        ready,
      }
    })
  }

  readyCount(): number {
    return this.getSnapshot().filter((entry) => entry.ready).length
  }

  hasPassed(): boolean {
    return this.getSnapshot().every((entry) => entry.ready)
  }

  getDisplayPorts(): {basePort: number; regroupPort: number} {
    return {
      basePort: this.localParty.basePort,
      regroupPort:
        this.localParty.regroupPort ??
        this.peers.find((party) => party.regroupPort !== undefined)?.regroupPort ??
        getRegroupPort(this.localParty.basePort),
    }
  }

  printStatus(statusLine = `Last updated: ${formatClock(this.now())}`): number {
    for (const line of buildStatusLines(this, statusLine)) {
      console.log(line)
    }
    return this.hasPassed() ? 0 : 1
  }

  private hasFreshInbound(key: string): boolean {
    const lastSeenAt = this.lastInboundAt.get(key)
    return lastSeenAt !== undefined && this.now() - lastSeenAt <= this.inboundStaleMs
  }
}

class LiveStatusRenderer {
  private renderedLines = 0
  private pending = false
  private statusLine = `Last updated: ${formatClock()}`

  constructor(
    private readonly tracker: RegroupConnectivityTracker,
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

function colorize(text: string, color: string, useColor: boolean): string {
  return useColor ? `${color}${text}${ANSI_RESET}` : text
}

export async function resolveRegroupConnectivityCheck(options: Options): Promise<ResolvedRegroupConnectivityCheck> {
  const signerRoot = resolveProjectRoot()
  const resolvedConfigPath = regroupCeremony.resolveRegroupCeremonyConfigPath(options.configPath, signerRoot)
  const config = regroupCeremony.loadRegroupCeremonyConfig(options.configPath, signerRoot)
  const resolution = await regroupCeremony.resolveRegroupPartyIndex(config)
  const basePort = options.port ?? bnbTss.getDefaultSlotListenPort(config.chainId)
  const regroupPort = getRegroupPort(basePort)
  const {activeOldPartyIps, parties} = buildRegroupParties(config, basePort)
  const localParty = parties.find((party) => party.partyIdx === resolution.partyIdx)

  if (!localParty) {
    throw new Error(`Failed to resolve local party ${resolution.partyIdx} from regroup-config.json`)
  }

  return {
    resolvedConfigPath,
    config,
    resolution,
    detectedLocalIps: resolution.detectedLocalIps,
    detectedExternalIps: resolution.detectedExternalIps,
    attemptedExternalLookup: resolution.attemptedExternalLookup,
    firewallState: detectFirewallState(),
    activeOldPartyIps,
    basePort,
    regroupPort,
    localParty,
    peers: parties.filter((party) => party.partyIdx !== localParty.partyIdx),
  }
}

export function logResolvedRegroupConnectivityCheck(check: ResolvedRegroupConnectivityCheck): void {
  console.log('Resolved regroup connectivity check:')
  console.log(`  config: ${check.resolvedConfigPath}`)
  console.log(`  chain id: ${check.config.chainId}`)
  console.log(`  active old participants: ${check.activeOldPartyIps.length}`)
  console.log(`  old threshold: ${check.config.oldThreshold} (requires ${check.config.oldThreshold + 1} old participants)`)
  console.log(`  new parties: ${check.config.newPartyIps.length}`)
  console.log(`  new threshold: ${check.config.newThreshold} (requires ${check.config.newThreshold + 1} signers)`)
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
  console.log(`  wrapper role: ${check.localParty.isActiveOld ? 'carry-over old member' : 'new-only member'}`)
  console.log(`  base listen port: ${check.basePort}`)
  console.log(`  regroup (+1000) listen port: ${check.localParty.regroupPort ?? '(not used on this machine)'}`)
  console.log(`  check interval: ${Math.floor(CHECK_INTERVAL_MS / 1000)} seconds`)
  console.log(`  peers to check (${check.peers.length}):`)
  for (const peer of check.peers) {
    console.log(
      `    party ${peer.partyIdx}: ${peer.ip} | ports: ${buildPeerPortsLabel(peer)}${peer.isActiveOld ? ' (base + regroup)' : ' (base only)'}`,
    )
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
  console.error('Copy and paste this to stop a stale regroup connectivity check and free the port:')
  console.error(`  pkill -f 'node dist/scripts/tss-regroup-connectivity-check.js' || true`)
  console.error('Then run the regroup connectivity check again.')
}

function isPortInUseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const errno = error as NodeJS.ErrnoException
  return errno.code === 'EADDRINUSE' || errno.message?.includes('EADDRINUSE') === true
}

async function closeServers(servers: net.Server[], sockets: Set<net.Socket>): Promise<void> {
  for (const socket of sockets) {
    socket.destroy()
  }

  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
}

type InboundServer = {
  server: net.Server
  port: number
}

function createInboundServer(
  chainId: number,
  localParty: RegroupConnectivityParty,
  peersByPartyIdx: Map<number, RegroupConnectivityParty>,
  tracker: RegroupConnectivityTracker,
  sockets: Set<net.Socket>,
  onStateChange: () => void,
  endpoint: EndpointKind,
  listenPort: number,
): InboundServer {
  const ackMessage = buildHelloMessage({
    type: 'hello-ack',
    chainId,
    partyIdx: localParty.partyIdx,
    endpoint,
  })

  const server = net.createServer((socket) => {
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
        if (hello.type !== 'hello' || hello.chainId !== chainId || hello.endpoint !== endpoint || !peer) {
          cleanup()
          return
        }

        if (tracker.markInbound(peer, endpoint)) {
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

  return {server, port: listenPort}
}

async function connectToPeer(
  peer: RegroupConnectivityParty,
  endpoint: EndpointKind,
  chainId: number,
  localHello: HelloMessage,
  signal?: AbortSignal,
): Promise<void> {
  const port = endpoint === 'base' ? peer.basePort : peer.regroupPort
  if (port === undefined) {
    throw new Error(`Peer ${peer.partyIdx} does not expose regroup port`)
  }

  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }

    const socket = net.createConnection({host: peer.ip, port})
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
        if (response.endpoint !== endpoint) {
          finish(new Error(`expected ${endpoint} ack from party ${peer.partyIdx}`))
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
  peer: RegroupConnectivityParty,
  endpoint: EndpointKind,
  check: ResolvedRegroupConnectivityCheck,
  tracker: RegroupConnectivityTracker,
  onStateChange: () => void,
  signal?: AbortSignal,
): Promise<void> {
  const localHello: HelloMessage = {
    type: 'hello',
    chainId: check.config.chainId,
    partyIdx: check.localParty.partyIdx,
    endpoint,
  }

  try {
    await connectToPeer(peer, endpoint, check.config.chainId, localHello, signal)
    if (tracker.markOutbound(peer, endpoint)) {
      onStateChange()
    }
  } catch {
    if (signal?.aborted) {
      return
    }
    if (tracker.markOutboundFailure(peer, endpoint)) {
      onStateChange()
    }
  }
}

export async function runRegroupConnectivityCycle(
  check: ResolvedRegroupConnectivityCheck,
  tracker: RegroupConnectivityTracker,
  onStateChange: () => void,
  signal?: AbortSignal,
): Promise<number> {
  const outboundTasks: Promise<void>[] = []

  for (const peer of check.peers) {
    outboundTasks.push(connectOnce(peer, 'base', check, tracker, onStateChange, signal))
    if (peer.isActiveOld) {
      outboundTasks.push(connectOnce(peer, 'regroup', check, tracker, onStateChange, signal))
    }
  }

  await Promise.allSettled(outboundTasks)
  return tracker.hasPassed() ? 0 : 1
}

export async function main(): Promise<void> {
  const check = await resolveRegroupConnectivityCheck(parseArgs(process.argv.slice(2)))
  logResolvedRegroupConnectivityCheck(check)
  const tracker = new RegroupConnectivityTracker(check.localParty, check.peers)
  const renderer = new LiveStatusRenderer(tracker)
  const peersByPartyIdx = new Map(check.peers.map((peer) => [peer.partyIdx, peer]))
  const sockets = new Set<net.Socket>()
  const shutdownController = new AbortController()
  let stopRequested = false

  const requestRender = () => {
    renderer.requestRender(buildStatusLine())
  }

  const servers: InboundServer[] = [
    createInboundServer(
      check.config.chainId,
      check.localParty,
      peersByPartyIdx,
      tracker,
      sockets,
      requestRender,
      'base',
      check.basePort,
    ),
  ]

  if (check.localParty.isActiveOld && check.localParty.regroupPort !== undefined) {
    servers.push(
      createInboundServer(
        check.config.chainId,
        check.localParty,
        peersByPartyIdx,
        tracker,
        sockets,
        requestRender,
        'regroup',
        check.localParty.regroupPort,
      ),
    )
  }

  const requestStop = () => {
    if (stopRequested) {
      return
    }

    stopRequested = true
    console.log('\nStopping regroup connectivity check...')
    shutdownController.abort()
  }

  process.once('SIGINT', requestStop)
  process.once('SIGTERM', requestStop)

  try {
    for (const entry of servers) {
      await waitForServerListening(entry.server, entry.port)
    }
  } catch (error) {
    const listenPort = servers.find((entry) => entry.server.listening === false)?.port
    if (isPortInUseError(error) && listenPort !== undefined) {
      logPortInUseHelp(listenPort)
      process.exitCode = 1
      return
    }
    throw error
  }

  if (check.localParty.isActiveOld && check.localParty.regroupPort !== undefined) {
    console.log(`Listening on 0.0.0.0:${check.basePort} and 0.0.0.0:${check.localParty.regroupPort}`)
  } else {
    console.log(`Listening on 0.0.0.0:${check.basePort}`)
  }
  console.log('This regroup connectivity check keeps running until you stop it.')
  console.log(`Rechecking every ${Math.floor(CHECK_INTERVAL_MS / 1000)} seconds.`)
  console.log('Press Ctrl+C to stop.')

  renderer.render(buildStatusLine(), true)

  let exitCode = 1

  try {
    while (!shutdownController.signal.aborted) {
      exitCode = await runRegroupConnectivityCycle(check, tracker, requestRender, shutdownController.signal)
      renderer.render(buildStatusLine(), !process.stdout.isTTY)
      await waitForInterval(CHECK_INTERVAL_MS, shutdownController.signal)
    }
  } finally {
    process.off('SIGINT', requestStop)
    process.off('SIGTERM', requestStop)
    await closeServers(
      servers.map((entry) => entry.server),
      sockets,
    )
  }

  process.exitCode = stopRequested ? 0 : exitCode
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
