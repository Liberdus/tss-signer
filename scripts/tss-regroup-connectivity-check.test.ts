import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as regroupCeremony from '../tss-tools/lib/regroupCeremony'
import {
  buildHelloMessage,
  buildRegroupParties,
  detectFirewallState,
  logResolvedRegroupConnectivityCheck,
  parseHelloMessage,
  RegroupConnectivityTracker,
  resolveRegroupConnectivityCheck,
} from './tss-regroup-connectivity-check'

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

function testBuildRegroupParties(): void {
  const {activeOldPartyIps, parties} = buildRegroupParties(
    {
      chainId: 102,
      oldPartyIps: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
      newPartyIps: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6', '10.0.0.7'],
      oldThreshold: 3,
      newThreshold: 3,
    },
    41012,
  )

  assert.deepEqual(activeOldPartyIps, ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'])
  assert.deepEqual(
    parties.map((party) => ({
      partyIdx: party.partyIdx,
      ip: party.ip,
      basePort: party.basePort,
      regroupPort: party.regroupPort,
      isActiveOld: party.isActiveOld,
    })),
    [
      {partyIdx: 1, ip: '10.0.0.1', basePort: 41012, regroupPort: 42012, isActiveOld: true},
      {partyIdx: 2, ip: '10.0.0.2', basePort: 41012, regroupPort: 42012, isActiveOld: true},
      {partyIdx: 3, ip: '10.0.0.3', basePort: 41012, regroupPort: 42012, isActiveOld: true},
      {partyIdx: 4, ip: '10.0.0.4', basePort: 41012, regroupPort: 42012, isActiveOld: true},
      {partyIdx: 5, ip: '10.0.0.5', basePort: 41012, regroupPort: undefined, isActiveOld: false},
      {partyIdx: 6, ip: '10.0.0.6', basePort: 41012, regroupPort: undefined, isActiveOld: false},
      {partyIdx: 7, ip: '10.0.0.7', basePort: 41012, regroupPort: undefined, isActiveOld: false},
    ],
  )
}

function testHelloMessageRoundTrip(): void {
  const raw = buildHelloMessage({
    type: 'hello',
    chainId: 102,
    partyIdx: 4,
    endpoint: 'regroup',
  })

  assert.equal(raw.endsWith('\n'), true)
  assert.deepEqual(parseHelloMessage(raw.trim()), {
    type: 'hello',
    chainId: 102,
    partyIdx: 4,
    endpoint: 'regroup',
  })
  assert.throws(() => parseHelloMessage('{"type":"hello"}'), /invalid handshake payload/)
}

async function testResolveRegroupConnectivityCheckWithPortOverride(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-regroup-connectivity-check-'))
  const configPath = path.join(tempDir, 'regroup-config.json')
  const config = {
    chainId: 102,
    oldPartyIps: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
    newPartyIps: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6', '10.0.0.7'],
    oldThreshold: 3,
    newThreshold: 3,
  }
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  const originalResolveRegroupPartyIndex = regroupCeremony.resolveRegroupPartyIndex

  try {
    ;(regroupCeremony as any).resolveRegroupPartyIndex = async () => ({
      partyIdx: 5,
      partyIp: '10.0.0.5',
      source: 'local',
      detectedLocalIps: ['10.0.0.5'],
      detectedExternalIps: [],
      attemptedExternalLookup: false,
    })

    const resolved = await resolveRegroupConnectivityCheck({configPath, port: 49999})

    assert.equal(resolved.resolvedConfigPath, configPath)
    assert.equal(resolved.basePort, 49999)
    assert.equal(resolved.regroupPort, 50999)
    assert.deepEqual(resolved.detectedLocalIps, ['10.0.0.5'])
    assert.equal(resolved.localParty.partyIdx, 5)
    assert.equal(resolved.localParty.ip, '10.0.0.5')
    assert.equal(resolved.localParty.regroupPort, undefined)
    assert.equal(resolved.peers.find((party) => party.partyIdx === 1)?.regroupPort, 50999)
    assert.equal(resolved.peers.find((party) => party.partyIdx === 6)?.regroupPort, undefined)
  } finally {
    ;(regroupCeremony as any).resolveRegroupPartyIndex = originalResolveRegroupPartyIndex
    fs.rmSync(tempDir, {recursive: true, force: true})
  }
}

function testTrackerForCarryOverLocalMember(): void {
  const localParty = {partyIdx: 1, ip: '10.0.0.1', basePort: 41012, regroupPort: 42012, isActiveOld: true}
  const oldPeer = {partyIdx: 2, ip: '10.0.0.2', basePort: 41012, regroupPort: 42012, isActiveOld: true}
  const newPeer = {partyIdx: 5, ip: '10.0.0.5', basePort: 41012, regroupPort: undefined, isActiveOld: false}
  const tracker = new RegroupConnectivityTracker(localParty, [oldPeer, newPeer], () => 0, 1_000)

  tracker.markInbound(oldPeer, 'base')
  tracker.markOutbound(oldPeer, 'base')
  tracker.markInbound(oldPeer, 'regroup')
  tracker.markOutbound(oldPeer, 'regroup')

  tracker.markInbound(newPeer, 'base')
  tracker.markOutbound(newPeer, 'base')
  tracker.markInbound(newPeer, 'regroup')

  const snapshot = tracker.getSnapshot()
  assert.equal(snapshot[0].ready, true)
  assert.equal(snapshot[1].baseInbound, true)
  assert.equal(snapshot[1].baseOutbound, true)
  assert.equal(snapshot[1].regroupInbound, true)
  assert.equal(snapshot[1].regroupOutbound, undefined)
  assert.equal(snapshot[1].ready, true)
}

function testTrackerForNewOnlyLocalMember(): void {
  const localParty = {partyIdx: 5, ip: '10.0.0.5', basePort: 41012, regroupPort: undefined, isActiveOld: false}
  const oldPeer = {partyIdx: 2, ip: '10.0.0.2', basePort: 41012, regroupPort: 42012, isActiveOld: true}
  const tracker = new RegroupConnectivityTracker(localParty, [oldPeer], () => 0, 1_000)

  tracker.markInbound(oldPeer, 'base')
  tracker.markOutbound(oldPeer, 'base')
  assert.equal(tracker.getSnapshot()[0].ready, false)

  tracker.markOutbound(oldPeer, 'regroup')
  const snapshot = tracker.getSnapshot()[0]
  assert.equal(snapshot.regroupInbound, undefined)
  assert.equal(snapshot.regroupOutbound, true)
  assert.equal(snapshot.ready, true)
}

async function testResolvedConnectivityLogging(): Promise<void> {
  const logs = await captureConsoleLogs(() => {
    logResolvedRegroupConnectivityCheck({
      resolvedConfigPath: '/tmp/regroup-config.json',
      config: {
        chainId: 102,
        oldPartyIps: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
        newPartyIps: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5'],
        oldThreshold: 3,
        newThreshold: 3,
      },
      resolution: {
        partyIdx: 5,
        partyIp: '10.0.0.5',
        source: 'local',
      },
      detectedLocalIps: ['10.0.0.5'],
      detectedExternalIps: [],
      attemptedExternalLookup: false,
      firewallState: 'inactive',
      activeOldPartyIps: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
      basePort: 41012,
      regroupPort: 42012,
      localParty: {
        partyIdx: 5,
        ip: '10.0.0.5',
        basePort: 41012,
        regroupPort: undefined,
        isActiveOld: false,
      },
      peers: [
        {partyIdx: 1, ip: '10.0.0.1', basePort: 41012, regroupPort: 42012, isActiveOld: true},
      ],
    })
  })

  assert(logs.includes('  firewall (ufw): inactive'))
  assert(logs.includes('  wrapper role: new-only member'))
  assert(logs.includes('  regroup (+1000) listen port: (not used on this machine)'))
  assert(logs.includes('  check interval: 5 seconds'))
}

function testDetectFirewallStateReturnsKnownValue(): void {
  assert(['active', 'inactive', 'unknown'].includes(detectFirewallState()))
}

async function main(): Promise<void> {
  testBuildRegroupParties()
  testHelloMessageRoundTrip()
  testDetectFirewallStateReturnsKnownValue()
  await testResolveRegroupConnectivityCheckWithPortOverride()
  testTrackerForCarryOverLocalMember()
  testTrackerForNewOnlyLocalMember()
  await testResolvedConnectivityLogging()
  console.log('regroup connectivity check tests passed')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
