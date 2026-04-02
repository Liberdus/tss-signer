import assert from 'node:assert/strict'
import {parseVerifyArgs} from './verifyArgs'

function failUsage(): never {
  throw new Error('usage')
}

function testParseVerifyArgsUsesExplicitChainIdWithoutConsultingConfig(): void {
  const options = parseVerifyArgs(['--chain-id', '97', '--format', 'ethereum-address'], failUsage, () => {
    throw new Error('config loader should not be called when --chain-id is provided')
  })

  assert.equal(options.chainId, 97)
  assert.equal(options.format, 'ethereum-address')
  assert.equal(options.useDefaultSlotPath, true)
}

function testParseVerifyArgsFallsBackToKeygenConfigChainId(): void {
  const options = parseVerifyArgs(['--format', 'compressed'], failUsage, () => ({chainId: 31337}))

  assert.equal(options.chainId, 31337)
  assert.equal(options.format, 'compressed')
  assert.equal(options.useDefaultSlotPath, true)
}

function testParseVerifyArgsPreservesExplicitPartyWithoutDefaultSlotPath(): void {
  const options = parseVerifyArgs(['--party', '2'], failUsage, () => ({chainId: 201}))

  assert.equal(options.chainId, 201)
  assert.equal(options.partyIdx, 2)
  assert.equal(options.useDefaultSlotPath, undefined)
}

function testParseVerifyArgsThrowsHelpfulErrorWhenChainIdCannotBeResolved(): void {
  assert.throws(
    () => parseVerifyArgs([], failUsage, () => {
      throw new Error('Missing keygen config at /tmp/keygen-config.json')
    }),
    /Missing chain id\. Pass --chain-id <id> or provide a valid keygen-config\.json/,
  )
}

function main(): void {
  testParseVerifyArgsUsesExplicitChainIdWithoutConsultingConfig()
  testParseVerifyArgsFallsBackToKeygenConfigChainId()
  testParseVerifyArgsPreservesExplicitPartyWithoutDefaultSlotPath()
  testParseVerifyArgsThrowsHelpfulErrorWhenChainIdCannotBeResolved()
  console.log('verify arg tests passed')
}

main()
