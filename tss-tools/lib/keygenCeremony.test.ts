import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  detectPartyIndexFromIps,
  deriveDeterministicKeygenChannelId,
  deriveDeterministicKeygenChannelPassword,
  deriveKeygenCeremonyConfig,
  deriveNextUtcMidnightUnix,
  deriveKeygenThreshold,
  isValidVaultPassword,
  resolveKeygenVaultPreparation,
  resolvePartyIndexFromCandidates,
  validateKeygenCeremonyConfig,
  writeDerivedParamsConfig,
} from './keygenCeremony'

const config = validateKeygenCeremonyConfig({
  chainId: 97,
  partyIps: [
    '138.197.201.44',
    '64.23.154.91',
    '146.190.88.173',
    '165.227.120.58',
    '159.89.207.131',
    '157.245.62.204',
    '134.209.33.76',
  ],
})

function testValidateKeygenCeremonyConfigRejectsBadInput(): void {
  assert.throws(() => validateKeygenCeremonyConfig(null), /JSON object/)
  assert.throws(
    () => validateKeygenCeremonyConfig({chainId: 97, partyIps: ['157.245.62.204', '157.245.62.204']}),
    /must not contain duplicates/,
  )
  assert.throws(
    () => validateKeygenCeremonyConfig({chainId: 97, partyIps: ['157.245.62.204', 'not-an-ip']}),
    /valid IPv4/,
  )
}

function testDeriveKeygenThreshold(): void {
  assert.equal(deriveKeygenThreshold(7), 3)
  assert.equal(deriveKeygenThreshold(6), 3)
}

function testIsValidVaultPassword(): void {
  assert.equal(isValidVaultPassword('12345678'), false)
  assert.equal(isValidVaultPassword('123456789'), true)
}

function testDetectPartyIndexFromIps(): void {
  assert.equal(detectPartyIndexFromIps(config.partyIps, ['10.0.0.2', '157.245.62.204']), 6)
  assert.throws(() => detectPartyIndexFromIps(config.partyIps, ['10.0.0.2']), /Unable to match/)
}

function testResolvePartyIndexFromCandidates(): void {
  assert.deepEqual(resolvePartyIndexFromCandidates(config.partyIps, ['10.0.0.2', '157.245.62.204']), {
    partyIdx: 6,
    source: 'local',
  })
  assert.deepEqual(resolvePartyIndexFromCandidates(config.partyIps, ['10.0.0.2'], ['157.245.62.204']), {
    partyIdx: 6,
    source: 'external',
  })
  assert.deepEqual(
    resolvePartyIndexFromCandidates(
      config.partyIps,
      ['138.197.201.44', '157.245.62.204'],
      ['157.245.62.204'],
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
  assert.equal(derived.committeePosition, 6)
  assert.equal(derived.committeePartyIp, '157.245.62.204')
  assert.equal(derived.listenPort, 40971)
  assert.equal(derived.listenAddr, '/ip4/0.0.0.0/tcp/40971')
  assert.deepEqual(derived.peerAddrs, [
    '/ip4/138.197.201.44/tcp/40971',
    '/ip4/64.23.154.91/tcp/40971',
    '/ip4/146.190.88.173/tcp/40971',
    '/ip4/165.227.120.58/tcp/40971',
    '/ip4/159.89.207.131/tcp/40971',
    '/ip4/134.209.33.76/tcp/40971',
  ])
}

function testResolveKeygenVaultPreparationForNewVault(): void {
  const signerRoot = path.join(os.tmpdir(), 'tss-keygen-test')
  const originalRequireInitialized = require('./bnbTss').requireInitialized
  try {
    require('./bnbTss').requireInitialized = () => {
      throw new Error('missing initialized party config')
    }
    assert.deepEqual(resolveKeygenVaultPreparation(signerRoot, 97), {
      vaultIsNew: true,
      vaultHome: path.join(signerRoot, 'keystores', 'bnbtss', 'chain-97'),
    })
  } finally {
    require('./bnbTss').requireInitialized = originalRequireInitialized
  }
}

function testResolveKeygenVaultPreparationForExistingVault(): void {
  const signerRoot = path.join(os.tmpdir(), 'tss-keygen-test')
  const originalRequireInitialized = require('./bnbTss').requireInitialized
  try {
    require('./bnbTss').requireInitialized = () => ({
      home: path.join(signerRoot, 'keystores', 'bnbtss', 'chain-97'),
      vaultName: 'default',
      binary: path.join(os.tmpdir(), 'tss'),
      tssRoot: path.join(os.tmpdir(), 'tss-root'),
    })
    assert.deepEqual(resolveKeygenVaultPreparation(signerRoot, 97), {
      vaultIsNew: false,
      vaultHome: path.join(signerRoot, 'keystores', 'bnbtss', 'chain-97'),
    })
  } finally {
    require('./bnbTss').requireInitialized = originalRequireInitialized
  }
}

function testResolveKeygenVaultPreparationUsesInitializedHome(): void {
  const signerRoot = path.join(os.tmpdir(), 'tss-keygen-test')
  const originalRequireInitialized = require('./bnbTss').requireInitialized
  const originalGetPartyHome = require('./bnbTss').getPartyHome
  try {
    const initializedHome = path.join(signerRoot, 'legacy', 'custom-home')
    require('./bnbTss').requireInitialized = () => ({
      home: initializedHome,
      vaultName: 'default',
      binary: path.join(os.tmpdir(), 'tss'),
      tssRoot: path.join(os.tmpdir(), 'tss-root'),
    })
    require('./bnbTss').getPartyHome = () => {
      throw new Error('should not compute home when initialized home exists')
    }
    assert.deepEqual(resolveKeygenVaultPreparation(signerRoot, 97), {
      vaultIsNew: false,
      vaultHome: initializedHome,
    })
  } finally {
    require('./bnbTss').requireInitialized = originalRequireInitialized
    require('./bnbTss').getPartyHome = originalGetPartyHome
  }
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

function testWriteDerivedParamsConfig(): void {
  const signerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-keygen-ceremony-'))
  try {
    const paramsPath = writeDerivedParamsConfig(signerRoot, {parties: 7, threshold: 3})
    assert.equal(paramsPath, path.join(signerRoot, 'params.json'))
    assert.equal(fs.readFileSync(paramsPath, 'utf8'), '{\n  "parties": 7,\n  "threshold": 3\n}\n')
  } finally {
    fs.rmSync(signerRoot, {recursive: true, force: true})
  }
}

function main(): void {
  testValidateKeygenCeremonyConfigRejectsBadInput()
  testDeriveKeygenThreshold()
  testIsValidVaultPassword()
  testDetectPartyIndexFromIps()
  testResolvePartyIndexFromCandidates()
  testDeriveKeygenCeremonyConfig()
  testResolveKeygenVaultPreparationForNewVault()
  testResolveKeygenVaultPreparationForExistingVault()
  testResolveKeygenVaultPreparationUsesInitializedHome()
  testDeterministicKeygenChannelCredentials()
  testWriteDerivedParamsConfig()
  console.log('keygen ceremony tests passed')
}

main()
