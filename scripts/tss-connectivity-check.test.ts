import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as keygenCeremony from '../tss-tools/lib/keygenCeremony'
import {
  buildHelloMessage,
  buildPeers,
  ConnectivityTracker,
  detectFirewallState,
  logResolvedConnectivityCheck,
  parseHelloMessage,
  resolveConnectivityCheck,
} from './tss-connectivity-check'

type ConsoleMethod = (...args: any[]) => void

async function captureConsoleLogs(fn: () => void | Promise<void>): Promise<string[]> {
  const logs: string[] = []
  const originalLog = console.log

  console.log = ((...args: any[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '))
  }) as ConsoleMethod

  try {
    await fn()
  } finally {
    console.log = originalLog
  }

  return logs
}

function testBuildPeers(): void {
  assert.deepEqual(
    buildPeers(['10.0.0.1', '10.0.0.2', '10.0.0.3'], 2, 41011),
    [
      {partyIdx: 1, ip: '10.0.0.1', port: 41011},
      {partyIdx: 3, ip: '10.0.0.3', port: 41011},
    ],
  )
}

function testHelloMessageRoundTrip(): void {
  const raw = buildHelloMessage({
    type: 'hello',
    chainId: 101,
    partyIdx: 4,
    ip: '57.131.48.75',
    port: 41011,
  })

  assert.equal(raw.endsWith('\n'), true)
  assert.deepEqual(parseHelloMessage(raw.trim()), {
    type: 'hello',
    chainId: 101,
    partyIdx: 4,
    ip: '57.131.48.75',
    port: 41011,
  })
  assert.throws(() => parseHelloMessage('{"type":"hello"}'), /invalid handshake payload/)
}

async function testResolveConnectivityCheckWithPortOverride(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-connectivity-check-'))
  const configPath = path.join(tempDir, 'keygen-config.json')
  const config = {
    chainId: 101,
    partyIps: ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const originalListLocalExternalIpv4s = keygenCeremony.listLocalExternalIpv4s
  const originalLookupExternalIpv4s = keygenCeremony.lookupExternalIpv4s

  try {
    ;(keygenCeremony as any).listLocalExternalIpv4s = () => ['10.0.0.2']
    ;(keygenCeremony as any).lookupExternalIpv4s = async () => {
      throw new Error('should not use external lookup when local IP matches')
    }

    const resolved = await resolveConnectivityCheck({configPath, port: 49999})

    assert.equal(resolved.resolvedConfigPath, configPath)
    assert.equal(resolved.config.chainId, 101)
    assert.deepEqual(resolved.detectedLocalIps, ['10.0.0.2'])
    assert.equal(resolved.attemptedExternalLookup, false)
    assert(['active', 'inactive', 'unknown'].includes(resolved.firewallState))
    assert.deepEqual(resolved.localParty, {
      partyIdx: 2,
      ip: '10.0.0.2',
      port: 49999,
    })
    assert.deepEqual(resolved.peers, [
      {partyIdx: 1, ip: '10.0.0.1', port: 49999},
      {partyIdx: 3, ip: '10.0.0.3', port: 49999},
    ])
  } finally {
    ;(keygenCeremony as any).listLocalExternalIpv4s = originalListLocalExternalIpv4s
    ;(keygenCeremony as any).lookupExternalIpv4s = originalLookupExternalIpv4s
    fs.rmSync(tempDir, {recursive: true, force: true})
  }
}

async function testConnectivityTrackerSuccess(): Promise<void> {
  const peers = [
    {partyIdx: 2, ip: '10.0.0.2', port: 41011},
    {partyIdx: 3, ip: '10.0.0.3', port: 41011},
  ]
  const tracker = new ConnectivityTracker(peers, () => 0, 1_000)

  tracker.markInbound(peers[0])
  tracker.markOutbound(peers[0])
  tracker.markInbound(peers[1])
  tracker.markOutbound(peers[1])

  const logs = await captureConsoleLogs(async () => {
    assert.equal(tracker.printStatus('Last updated: 12:00:00'), 0)
  })

  assert(logs.includes('Connectivity status:'))
  assert(logs.some((line) => line.includes('Party') && line.includes('Address') && line.includes('Ready')))
  assert(logs.some((line) => line.includes('10.0.0.2:41011') && line.includes('OK') && line.includes('OK')))
  assert(logs.includes('Overall: OK 2/2 peers ready'))
}

function testConnectivityTrackerInboundExpires(): void {
  const peers = [{partyIdx: 2, ip: '10.0.0.2', port: 41011}]
  let now = 0
  const tracker = new ConnectivityTracker(peers, () => now, 1_000)

  tracker.markInbound(peers[0])
  tracker.markOutbound(peers[0])
  assert.equal(tracker.getSnapshot()[0].ready, true)

  now = 1_001
  const snapshot = tracker.getSnapshot()[0]
  assert.equal(snapshot.inbound, false)
  assert.equal(snapshot.outbound, true)
  assert.equal(snapshot.ready, false)
}

function testConnectivityTrackerOutboundFailureClearsStatus(): void {
  const peers = [{partyIdx: 2, ip: '10.0.0.2', port: 41011}]
  const tracker = new ConnectivityTracker(peers, () => 0, 1_000)

  tracker.markInbound(peers[0])
  tracker.markOutbound(peers[0])
  assert.equal(tracker.getSnapshot()[0].ready, true)

  tracker.markOutboundFailure(peers[0])
  const snapshot = tracker.getSnapshot()[0]
  assert.equal(snapshot.inbound, true)
  assert.equal(snapshot.outbound, false)
  assert.equal(snapshot.ready, false)
}

async function testResolvedConnectivityLogging(): Promise<void> {
  const logs = await captureConsoleLogs(() => {
    logResolvedConnectivityCheck({
      resolvedConfigPath: '/tmp/keygen-config.json',
      config: {
        chainId: 101,
        partyIps: ['10.0.0.1', '10.0.0.2'],
      },
      resolution: {
        partyIdx: 1,
        source: 'local',
      },
      detectedLocalIps: ['10.0.0.1'],
      detectedExternalIps: [],
      attemptedExternalLookup: false,
      firewallState: 'inactive',
      localParty: {
        partyIdx: 1,
        ip: '10.0.0.1',
        port: 41011,
      },
      peers: [
        {partyIdx: 2, ip: '10.0.0.2', port: 41011},
      ],
    })
  })

  assert(logs.includes('  firewall (ufw): inactive'))
  assert(logs.includes('  check interval: 5 seconds'))
}

function testDetectFirewallStateReturnsKnownValue(): void {
  assert(['active', 'inactive', 'unknown'].includes(detectFirewallState()))
}

async function main(): Promise<void> {
  testBuildPeers()
  testHelloMessageRoundTrip()
  testDetectFirewallStateReturnsKnownValue()
  await testResolveConnectivityCheckWithPortOverride()
  await testConnectivityTrackerSuccess()
  testConnectivityTrackerInboundExpires()
  testConnectivityTrackerOutboundFailureClearsStatus()
  await testResolvedConnectivityLogging()
  console.log('connectivity check tests passed')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
