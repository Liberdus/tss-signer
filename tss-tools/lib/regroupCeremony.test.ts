import assert from 'node:assert/strict'
import {
  deriveDeterministicRegroupChannelId,
  deriveDeterministicRegroupChannelPassword,
  deriveRegroupCeremonyConfig,
  deriveOrderedRegroupPeerAddrs,
  validateRegroupCeremonyConfig,
} from './regroupCeremony'
import {getIpBasedMoniker} from './bnbTss'

const config = validateRegroupCeremonyConfig({
  chainId: 97,
  oldPartyIps: ['145.223.74.11', '104.238.181.92', '172.232.45.137'],
  newPartyIps: ['145.223.74.11', '104.238.181.92', '172.232.45.137', '66.228.53.24', '198.74.61.203'],
  oldThreshold: 2,
  newThreshold: 3,
})

function testValidateRegroupCeremonyConfigRejectsBadInput(): void {
  assert.throws(() => validateRegroupCeremonyConfig(null), /JSON object/)
  assert.throws(
    () =>
      validateRegroupCeremonyConfig({
        chainId: 97,
        oldPartyIps: ['145.223.74.11', '145.223.74.11', '172.232.45.137'],
        newPartyIps: ['145.223.74.11', '104.238.181.92', '172.232.45.137', '66.228.53.24', '198.74.61.203'],
        oldThreshold: 2,
        newThreshold: 3,
      }),
    /must not contain duplicates/,
  )
  assert.throws(
    () =>
      validateRegroupCeremonyConfig({
        chainId: 97,
        oldPartyIps: ['145.223.74.11', '104.238.181.92'],
        newPartyIps: ['145.223.74.11', '104.238.181.92', '172.232.45.137', '66.228.53.24', '198.74.61.203'],
        oldThreshold: 2,
        newThreshold: 3,
      }),
    /must equal oldThreshold \+ 1/,
  )
  assert.throws(
    () =>
      validateRegroupCeremonyConfig({
        chainId: 97,
        oldPartyIps: ['145.223.74.11', '104.238.181.92', '203.0.113.10'],
        newPartyIps: ['145.223.74.11', '104.238.181.92', '172.232.45.137', '66.228.53.24', '198.74.61.203'],
        oldThreshold: 2,
        newThreshold: 3,
      }),
    /must also be present in newPartyIps/,
  )
}

function testDeriveRegroupCeremonyConfigForCarryOverMember(): void {
  const derived = deriveRegroupCeremonyConfig(config, '145.223.74.11')

  assert.equal(derived.chainId, 97)
  assert.equal(derived.committeePosition, 1)
  assert.equal(derived.committeePartyIp, '145.223.74.11')
  assert.equal(derived.oldParties, 3)
  assert.equal(derived.newParties, 5)
  assert.equal(derived.oldThreshold, 2)
  assert.equal(derived.newThreshold, 3)
  assert.equal(derived.isOld, true)
  assert.equal(derived.isNewMember, false)
  assert.equal(derived.newListenPort, 41971)
  assert.equal(derived.newListenAddr, '/ip4/0.0.0.0/tcp/41971')
  assert.deepEqual(derived.newPeerAddrs, [
    '/ip4/104.238.181.92/tcp/40971',
    '/ip4/172.232.45.137/tcp/40971',
    '/ip4/104.238.181.92/tcp/41971',
    '/ip4/145.223.74.11/tcp/41971',
    '/ip4/172.232.45.137/tcp/41971',
    '/ip4/66.228.53.24/tcp/40971',
    '/ip4/198.74.61.203/tcp/40971',
  ])
}

function testDeriveRegroupCeremonyConfigForNewOnlyMember(): void {
  const derived = deriveRegroupCeremonyConfig(config, '198.74.61.203')

  assert.equal(derived.chainId, 97)
  assert.equal(derived.committeePosition, 5)
  assert.equal(derived.committeePartyIp, '198.74.61.203')
  assert.equal(derived.oldParties, 3)
  assert.equal(derived.newParties, 5)
  assert.equal(derived.oldThreshold, 2)
  assert.equal(derived.newThreshold, 3)
  assert.equal(derived.isOld, false)
  assert.equal(derived.isNewMember, true)
  assert.equal(derived.newListenPort, undefined)
  assert.equal(derived.newListenAddr, undefined)
  assert.deepEqual(derived.newPeerAddrs, [
    '/ip4/104.238.181.92/tcp/40971',
    '/ip4/145.223.74.11/tcp/40971',
    '/ip4/172.232.45.137/tcp/40971',
    '/ip4/104.238.181.92/tcp/41971',
    '/ip4/145.223.74.11/tcp/41971',
    '/ip4/172.232.45.137/tcp/41971',
    '/ip4/66.228.53.24/tcp/40971',
  ])
}

function testDeriveOrderedRegroupPeerAddrsForCarryOverMember(): void {
  assert.deepEqual(
    deriveOrderedRegroupPeerAddrs({
      chainId: config.chainId,
      oldPartyIps: config.oldPartyIps,
      newPartyIps: config.newPartyIps,
      oldThreshold: config.oldThreshold,
      committeePartyIp: '145.223.74.11',
      isOld: true,
    }),
    [
      '/ip4/104.238.181.92/tcp/40971',
      '/ip4/172.232.45.137/tcp/40971',
      '/ip4/104.238.181.92/tcp/41971',
      '/ip4/145.223.74.11/tcp/41971',
      '/ip4/172.232.45.137/tcp/41971',
      '/ip4/66.228.53.24/tcp/40971',
      '/ip4/198.74.61.203/tcp/40971',
    ],
  )
}

function testDeriveOrderedRegroupPeerAddrsForNewOnlyMember(): void {
  assert.deepEqual(
    deriveOrderedRegroupPeerAddrs({
      chainId: config.chainId,
      oldPartyIps: config.oldPartyIps,
      newPartyIps: config.newPartyIps,
      oldThreshold: config.oldThreshold,
      committeePartyIp: '198.74.61.203',
      isNewMember: true,
    }),
    [
      '/ip4/104.238.181.92/tcp/40971',
      '/ip4/145.223.74.11/tcp/40971',
      '/ip4/172.232.45.137/tcp/40971',
      '/ip4/104.238.181.92/tcp/41971',
      '/ip4/145.223.74.11/tcp/41971',
      '/ip4/172.232.45.137/tcp/41971',
      '/ip4/66.228.53.24/tcp/40971',
    ],
  )
}

function testReorderedOldPartyIpsProduceSameDerivedPeerAddrs(): void {
  const reordered = validateRegroupCeremonyConfig({
    chainId: 97,
    oldPartyIps: ['172.232.45.137', '145.223.74.11', '104.238.181.92'],
    newPartyIps: config.newPartyIps,
    oldThreshold: 2,
    newThreshold: 3,
  })

  const carryOver = deriveRegroupCeremonyConfig(reordered, '145.223.74.11')
  const newOnly = deriveRegroupCeremonyConfig(reordered, '198.74.61.203')

  assert.deepEqual(carryOver.newPeerAddrs, deriveRegroupCeremonyConfig(config, '145.223.74.11').newPeerAddrs)
  assert.deepEqual(newOnly.newPeerAddrs, deriveRegroupCeremonyConfig(config, '198.74.61.203').newPeerAddrs)
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
  assert.equal(channelPassword.length, 64)
  assert.match(channelPassword, /^[0-9a-f]+$/)
}

function testReorderedOldPartyIpsProduceSameChannelCredentials(): void {
  const reordered = validateRegroupCeremonyConfig({
    chainId: 97,
    oldPartyIps: ['172.232.45.137', '145.223.74.11', '104.238.181.92'],
    newPartyIps: config.newPartyIps,
    oldThreshold: 2,
    newThreshold: 3,
  })
  const fixedNow = new Date('2026-03-31T19:24:57Z')
  const channelId = deriveDeterministicRegroupChannelId(config, '1', fixedNow)
  const reorderedChannelId = deriveDeterministicRegroupChannelId(reordered, '1', fixedNow)
  const channelPassword = deriveDeterministicRegroupChannelPassword(config, '1', channelId)
  const reorderedChannelPassword = deriveDeterministicRegroupChannelPassword(reordered, '1', reorderedChannelId)

  assert.equal(channelId, reorderedChannelId)
  assert.equal(channelPassword, reorderedChannelPassword)
}

function testReorderedNewPartyIpsKeepSameIpBasedMoniker(): void {
  const reordered = validateRegroupCeremonyConfig({
    chainId: 97,
    oldPartyIps: config.oldPartyIps,
    newPartyIps: ['198.74.61.203', '145.223.74.11', '104.238.181.92', '172.232.45.137', '66.228.53.24'],
    oldThreshold: 2,
    newThreshold: 3,
  })

  const originalDerived = deriveRegroupCeremonyConfig(config, '198.74.61.203')
  const reorderedDerived = deriveRegroupCeremonyConfig(reordered, '198.74.61.203')

  assert.notEqual(originalDerived.committeePosition, reorderedDerived.committeePosition)
  assert.equal(
    getIpBasedMoniker(config.chainId, originalDerived.committeePartyIp),
    getIpBasedMoniker(reordered.chainId, reorderedDerived.committeePartyIp),
  )
}

function main(): void {
  testValidateRegroupCeremonyConfigRejectsBadInput()
  testDeriveRegroupCeremonyConfigForCarryOverMember()
  testDeriveRegroupCeremonyConfigForNewOnlyMember()
  testDeriveOrderedRegroupPeerAddrsForCarryOverMember()
  testDeriveOrderedRegroupPeerAddrsForNewOnlyMember()
  testReorderedOldPartyIpsProduceSameDerivedPeerAddrs()
  testDeterministicRegroupChannelCredentials()
  testReorderedOldPartyIpsProduceSameChannelCredentials()
  testReorderedNewPartyIpsKeepSameIpBasedMoniker()
  console.log('regroup ceremony tests passed')
}

main()
