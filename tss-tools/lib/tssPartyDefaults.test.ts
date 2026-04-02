import assert from 'node:assert/strict'
import * as path from 'node:path'
import {DEFAULT_RUNTIME_PARTY_IDX, deriveObserverUrl, deriveTransactionsDbPath, resolveRuntimePartyIdx} from './tssPartyDefaults'

function testResolveRuntimePartyIdxDefaultsToOne(): void {
  assert.equal(resolveRuntimePartyIdx(), DEFAULT_RUNTIME_PARTY_IDX)
  assert.equal(resolveRuntimePartyIdx(''), DEFAULT_RUNTIME_PARTY_IDX)
}

function testResolveRuntimePartyIdxPreservesExplicitIndex(): void {
  assert.equal(resolveRuntimePartyIdx('4'), 4)
}

function testResolveRuntimePartyIdxRejectsInvalidInput(): void {
  assert.throws(() => resolveRuntimePartyIdx('0'), /Invalid party index/)
  assert.throws(() => resolveRuntimePartyIdx('abc'), /Invalid party index/)
}

function testNumericArgDetectionMatchesTssPartyBehavior(): void {
  const asParsedIdx = (arg?: string): string | undefined =>
    arg != null && /^\d+$/.test(`${arg}`.trim()) ? arg : undefined

  assert.equal(asParsedIdx(undefined), undefined)
  assert.equal(asParsedIdx(''), undefined)
  assert.equal(asParsedIdx('4'), '4')
  assert.equal(asParsedIdx('validate'), undefined)
}

function testDeriveObserverUrl(): void {
  assert.equal(deriveObserverUrl(1), 'http://127.0.0.1:8101')
  assert.equal(deriveObserverUrl(4), 'http://127.0.0.1:8104')
}

function testDeriveTransactionsDbPath(): void {
  assert.equal(
    deriveTransactionsDbPath(path.join(path.sep, 'tmp', 'tss'), 1),
    path.resolve(path.join(path.sep, 'tmp', 'tss'), 'db', 'transactions-1.sqlite'),
  )
}

function main(): void {
  testResolveRuntimePartyIdxDefaultsToOne()
  testResolveRuntimePartyIdxPreservesExplicitIndex()
  testResolveRuntimePartyIdxRejectsInvalidInput()
  testNumericArgDetectionMatchesTssPartyBehavior()
  testDeriveObserverUrl()
  testDeriveTransactionsDbPath()
  console.log('tss-party defaults tests passed')
}

main()
