import assert from 'assert'
import {
  bytesToKb,
  formatResultSummary,
  formatUniqueAdminTimestamp,
  normalizeObserverUrl,
  parseArgs,
  resolveTargets,
  UsageError,
  validateRestartName,
} from './operator-admin'
import {getArchiveFilenameForObserverUrl} from '../observer/admin'

function assertThrowsMessage(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error) => error instanceof Error && pattern.test(error.message))
}

function testParseArgs(): void {
  const parsed = parseArgs([
    '--action',
    'restart',
    '--target',
    'http://203.0.113.3:8103',
    '--name',
    'tss-party',
    '--yes',
  ])
  assert.deepStrictEqual(parsed, {
    action: 'restart',
    target: 'http://203.0.113.3:8103',
    name: 'tss-party',
    yes: true,
  })
  assertThrowsMessage(() => parseArgs(['--action', 'stop']), /Invalid action/)
  assert.throws(() => parseArgs(['--bad']), UsageError)
}

function testTargetSelection(): void {
  const observerUrls = [
    normalizeObserverUrl('http://203.0.113.1:8101/'),
    normalizeObserverUrl('http://203.0.113.2:8102'),
  ]

  assert.deepStrictEqual(resolveTargets('all', observerUrls), observerUrls)
  assert.deepStrictEqual(resolveTargets('http://203.0.113.1:8101/', observerUrls), [observerUrls[0]])
  assertThrowsMessage(() => resolveTargets('http://203.0.113.3:8103', observerUrls), /not present/)
}

function testRestartNameValidation(): void {
  assert.strictEqual(validateRestartName(' tss-party '), 'tss-party')
  assert.strictEqual(validateRestartName('observer'), 'observer')
  assertThrowsMessage(() => validateRestartName('observer-11'), /Invalid PM2/)
  assertThrowsMessage(() => validateRestartName('tss-party && observer'), /Invalid PM2/)
}

function testArchiveFilenameGeneration(): void {
  assert.strictEqual(getArchiveFilenameForObserverUrl('http://203.0.113.3:8103'), '203.0.113.3-8103.tar.gz')
  assert.strictEqual(getArchiveFilenameForObserverUrl('http://[2001:db8::1]:8103'), '2001_db8__1-8103.tar.gz')
}

function testTimestampsAndSummary(): void {
  assert.strictEqual(bytesToKb(10240), 10)
  assert.strictEqual(bytesToKb(1536), 1.5)
  assert.strictEqual(
    formatUniqueAdminTimestamp(new Date(2026, 4, 14, 18, 30, 0, 7)),
    '2026-05-14-18-30-00',
  )
  assert.strictEqual(
    formatResultSummary([
      {url: 'http://203.0.113.1:8101', status: 'ok'},
      {url: 'http://203.0.113.2:8102', status: 'failed', error: 'timeout'},
    ]),
    'success=1/2 fail=1/2\nfailed http://203.0.113.2:8102: timeout',
  )
}

testParseArgs()
testTargetSelection()
testRestartNameValidation()
testArchiveFilenameGeneration()
testTimestampsAndSummary()

console.log('operator-admin tests passed')
