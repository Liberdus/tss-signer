import assert from 'node:assert/strict'
import {deriveDeterministicKeygenChannelId} from './keygenCeremony'
import {
  deriveDeterministicRegroupChannelId,
  deriveDeterministicRegroupChannelPassword,
  deriveOrderedRegroupPeerAddrs,
  deriveRegroupCeremonyConfig,
  validateRegroupCeremonyConfig,
} from './regroupCeremony'

const config = validateRegroupCeremonyConfig({
  chainId: 201,
  oldPartyIps: [
    '145.223.74.11',
    '104.238.181.92',
    '172.232.45.137',
    '66.228.53.24',
    '198.74.61.203',
  ],
  newPartyIps: [
    '145.223.74.11',
    '104.238.181.92',
    '172.232.45.137',
    '66.228.53.24',
    '198.74.61.203',
  ],
  oldThreshold: 2,
  newThreshold: 3,
})

function testValidateRegroupCeremonyConfigRejectsBadInput(): void {
  assert.throws(() => validateRegroupCeremonyConfig(null), /JSON object/)
  assert.throws(
    () =>
      validateRegroupCeremonyConfig({
        chainId: 201,
        oldPartyIps: ['145.223.74.11', '145.223.74.11'],
        newPartyIps: ['145.223.74.11', '104.238.181.92'],
        oldThreshold: 1,
        newThreshold: 1,
      }),
    /oldPartyIps must not contain duplicates/,
  )
  assert.throws(
    () =>
      validateRegroupCeremonyConfig({
        chainId: 201,
        oldPartyIps: ['145.223.74.11', '104.238.181.92'],
        newPartyIps: ['145.223.74.11', 'not-an-ip'],
        oldThreshold: 1,
        newThreshold: 1,
      }),
    /valid IPv4/,
  )
  assert.throws(
    () =>
      validateRegroupCeremonyConfig({
        chainId: 201,
        oldPartyIps: ['145.223.74.11', '104.238.181.92'],
        newPartyIps: ['145.223.74.11', '104.238.181.92'],
        oldThreshold: 2,
        newThreshold: 1,
      }),
    /oldThreshold \+ 1/,
  )
}

function testDeriveRegroupCeremonyConfigForCarryOverMember(): void {
  const derived = deriveRegroupCeremonyConfig(config, 1)

  assert.equal(derived.committeePosition, 1)
  assert.equal(derived.isOld, true)
  assert.equal(derived.isNewMember, false)
  assert.equal(derived.committeePartyIp, '145.223.74.11')
  assert.equal(derived.newListenAddr, '/ip4/0.0.0.0/tcp/43011')
  assert.deepEqual(derived.newPeerAddrs, [
    '/ip4/104.238.181.92/tcp/42011',
    '/ip4/172.232.45.137/tcp/42011',
    '/ip4/145.223.74.11/tcp/43011',
    '/ip4/104.238.181.92/tcp/43011',
    '/ip4/172.232.45.137/tcp/43011',
    '/ip4/66.228.53.24/tcp/43011',
    '/ip4/198.74.61.203/tcp/43011',
  ])
  assert.equal(derived.newPeerAddrs.length, 7)
}

function testDeriveOrderedRegroupPeerAddrsForCarryOverMember(): void {
  const peerAddrs = deriveOrderedRegroupPeerAddrs({
    chainId: 201,
    oldPartyIps: config.oldPartyIps,
    newPartyIps: config.newPartyIps,
    oldThreshold: 2,
    committeePosition: 1,
    committeePartyIp: '145.223.74.11',
    isOld: true,
  })

  assert.deepEqual(peerAddrs, [
    '/ip4/104.238.181.92/tcp/42011',
    '/ip4/172.232.45.137/tcp/42011',
    '/ip4/145.223.74.11/tcp/43011',
    '/ip4/104.238.181.92/tcp/43011',
    '/ip4/172.232.45.137/tcp/43011',
    '/ip4/66.228.53.24/tcp/43011',
    '/ip4/198.74.61.203/tcp/43011',
  ])
}

function testDeriveRegroupCeremonyConfigForNewOnlyMember(): void {
  const changedConfig = validateRegroupCeremonyConfig({
    chainId: 201,
    oldPartyIps: ['145.223.74.11', '104.238.181.92', '172.232.45.137'],
    newPartyIps: ['145.223.74.11', '104.238.181.92', '172.232.45.137', '66.228.53.24', '198.74.61.203'],
    oldThreshold: 2,
    newThreshold: 3,
  })
  const derived = deriveRegroupCeremonyConfig(changedConfig, 5)

  assert.equal(derived.committeePosition, 5)
  assert.equal(derived.isOld, false)
  assert.equal(derived.isNewMember, true)
  assert.equal(derived.newListenAddr, undefined)
  assert.deepEqual(derived.newPeerAddrs, [
    '/ip4/145.223.74.11/tcp/42011',
    '/ip4/104.238.181.92/tcp/42011',
    '/ip4/172.232.45.137/tcp/42011',
    '/ip4/145.223.74.11/tcp/43011',
    '/ip4/104.238.181.92/tcp/43011',
    '/ip4/172.232.45.137/tcp/43011',
    '/ip4/66.228.53.24/tcp/42011',
  ])
  assert.equal(derived.newPeerAddrs.length, 7)
}

function testDeriveOrderedRegroupPeerAddrsForNewOnlyMember(): void {
  const peerAddrs = deriveOrderedRegroupPeerAddrs({
    chainId: 201,
    oldPartyIps: ['145.223.74.11', '104.238.181.92', '172.232.45.137'],
    newPartyIps: ['145.223.74.11', '104.238.181.92', '172.232.45.137', '66.228.53.24', '198.74.61.203'],
    oldThreshold: 2,
    committeePosition: 5,
    committeePartyIp: '198.74.61.203',
    isNewMember: true,
  })

  assert.deepEqual(peerAddrs, [
    '/ip4/145.223.74.11/tcp/42011',
    '/ip4/104.238.181.92/tcp/42011',
    '/ip4/172.232.45.137/tcp/42011',
    '/ip4/145.223.74.11/tcp/43011',
    '/ip4/104.238.181.92/tcp/43011',
    '/ip4/172.232.45.137/tcp/43011',
    '/ip4/66.228.53.24/tcp/42011',
  ])
}

function testDeriveRegroupCeremonyConfigSupportsDifferentNewOrder(): void {
  const changedConfig = validateRegroupCeremonyConfig({
    chainId: 201,
    oldPartyIps: ['145.223.74.11', '104.238.181.92', '172.232.45.137'],
    newPartyIps: ['66.228.53.24', '145.223.74.11', '104.238.181.92', '172.232.45.137', '198.74.61.203'],
    oldThreshold: 2,
    newThreshold: 3,
  })
  const derived = deriveRegroupCeremonyConfig(changedConfig, 1)

  assert.equal(derived.committeePosition, 1)
  assert.equal(derived.committeePartyIp, '66.228.53.24')
  assert.equal(derived.newListenAddr, undefined)
  assert.equal(derived.isNewMember, true)
}

function testDeterministicRegroupChannelCredentials(): void {
  const fixedNow = new Date('2026-03-31T19:24:57Z')
  const channelId = deriveDeterministicRegroupChannelId(config, '1', fixedNow)
  const sameChannelId = deriveDeterministicRegroupChannelId(config, '1', fixedNow)
  const differentChannelId = deriveDeterministicRegroupChannelId(config, '2', fixedNow)
  const channelPassword = deriveDeterministicRegroupChannelPassword(config, '1', channelId)

  assert.equal(channelId.length, 11)
  assert.match(channelId, /^\d{3}[0-9A-F]{8}$/)
  assert.equal(channelId, sameChannelId)
  assert.notEqual(channelId, differentChannelId)
  assert.notEqual(
    channelId,
    deriveDeterministicKeygenChannelId({chainId: 201, partyIps: config.newPartyIps}, '1', fixedNow),
  )
  assert.equal(channelPassword.length, 64)
  assert.match(channelPassword, /^[0-9a-f]+$/)
}

function main(): void {
  testValidateRegroupCeremonyConfigRejectsBadInput()
  testDeriveOrderedRegroupPeerAddrsForCarryOverMember()
  testDeriveOrderedRegroupPeerAddrsForNewOnlyMember()
  testDeriveRegroupCeremonyConfigForCarryOverMember()
  testDeriveRegroupCeremonyConfigForNewOnlyMember()
  testDeriveRegroupCeremonyConfigSupportsDifferentNewOrder()
  testDeterministicRegroupChannelCredentials()
  console.log('regroup ceremony tests passed')
}

main()
