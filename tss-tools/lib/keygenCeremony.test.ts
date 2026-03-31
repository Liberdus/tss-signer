import assert from 'node:assert/strict'
import {
  detectPartyIndexFromIps,
  deriveDeterministicKeygenChannelId,
  deriveDeterministicKeygenChannelPassword,
  deriveKeygenCeremonyConfig,
  deriveNextUtcMidnightUnix,
  deriveKeygenThreshold,
  resolvePartyIndexFromCandidates,
  validateKeygenCeremonyConfig,
} from './keygenCeremony'

const config = validateKeygenCeremonyConfig({
  chainId: 97,
  partyIps: [
    '89.167.95.133',
    '187.124.118.138',
    '23.239.29.227',
    '57.131.48.75',
    '195.35.2.41',
    '216.250.112.204',
    '187.124.247.126',
  ],
})

function testValidateKeygenCeremonyConfigRejectsBadInput(): void {
  assert.throws(() => validateKeygenCeremonyConfig(null), /JSON object/)
  assert.throws(
    () => validateKeygenCeremonyConfig({chainId: 97, partyIps: ['216.250.112.204', '216.250.112.204']}),
    /must not contain duplicates/,
  )
  assert.throws(
    () => validateKeygenCeremonyConfig({chainId: 97, partyIps: ['216.250.112.204', 'not-an-ip']}),
    /valid IPv4/,
  )
}

function testDeriveKeygenThreshold(): void {
  assert.equal(deriveKeygenThreshold(7), 3)
  assert.equal(deriveKeygenThreshold(6), 3)
}

function testDetectPartyIndexFromIps(): void {
  assert.equal(detectPartyIndexFromIps(config.partyIps, ['10.0.0.2', '216.250.112.204']), 6)
  assert.throws(() => detectPartyIndexFromIps(config.partyIps, ['10.0.0.2']), /Unable to match/)
}

function testResolvePartyIndexFromCandidates(): void {
  assert.deepEqual(resolvePartyIndexFromCandidates(config.partyIps, ['10.0.0.2', '216.250.112.204']), {
    partyIdx: 6,
    source: 'local',
  })
  assert.deepEqual(resolvePartyIndexFromCandidates(config.partyIps, ['10.0.0.2'], ['216.250.112.204']), {
    partyIdx: 6,
    source: 'external',
  })
  assert.deepEqual(
    resolvePartyIndexFromCandidates(
      config.partyIps,
      ['89.167.95.133', '216.250.112.204'],
      ['216.250.112.204'],
    ),
    {
      partyIdx: 6,
      source: 'external',
    },
  )
  assert.throws(
    () => resolvePartyIndexFromCandidates(config.partyIps, ['10.0.0.2'], []),
    /Unable to match any local IPv4 address/,
  )
}

function testDeriveKeygenCeremonyConfig(): void {
  const derived = deriveKeygenCeremonyConfig(config, 6)

  assert.equal(derived.parties, 7)
  assert.equal(derived.threshold, 3)
  assert.equal(derived.listenPort, 40976)
  assert.equal(derived.listenAddr, '/ip4/0.0.0.0/tcp/40976')
  assert.deepEqual(derived.peerAddrs, [
    '/ip4/89.167.95.133/tcp/40971',
    '/ip4/187.124.118.138/tcp/40972',
    '/ip4/23.239.29.227/tcp/40973',
    '/ip4/57.131.48.75/tcp/40974',
    '/ip4/195.35.2.41/tcp/40975',
    '/ip4/187.124.247.126/tcp/40977',
  ])
}

function testDeterministicKeygenChannelCredentials(): void {
  const fixedNow = new Date('2026-03-31T19:24:57Z')
  const expectedExpiryHex = deriveNextUtcMidnightUnix(fixedNow).toString(16).toUpperCase().padStart(8, '0')
  const channelId = deriveDeterministicKeygenChannelId(config, '1', fixedNow)
  const sameChannelId = deriveDeterministicKeygenChannelId(config, '1', fixedNow)
  const differentChannelId = deriveDeterministicKeygenChannelId(config, '2', fixedNow)
  const channelPassword = deriveDeterministicKeygenChannelPassword(config, '1', channelId)

  assert.equal(channelId.length, 11)
  assert.match(channelId, /^\d{3}[0-9A-F]{8}$/)
  assert.equal(channelId, sameChannelId)
  assert.notEqual(channelId, differentChannelId)
  assert.equal(channelId.slice(3), expectedExpiryHex)
  assert.equal(channelPassword.length, 64)
  assert.match(channelPassword, /^[0-9a-f]+$/)
}

function main(): void {
  testValidateKeygenCeremonyConfigRejectsBadInput()
  testDeriveKeygenThreshold()
  testDetectPartyIndexFromIps()
  testResolvePartyIndexFromCandidates()
  testDeriveKeygenCeremonyConfig()
  testDeterministicKeygenChannelCredentials()
  console.log('keygen ceremony tests passed')
}

main()
