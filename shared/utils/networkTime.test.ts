import assert from 'node:assert/strict'
import {
  DEFAULT_NTP_TIMEOUT_MS,
  getNetworkTimeOffsetMs,
  initializeNetworkTime,
  networkNowMs,
  resetNetworkTimeForTests,
} from './networkTime'

async function testValidOffsetIsApplied(): Promise<void> {
  resetNetworkTimeForTests()
  const realNow = Date.now
  Date.now = () => 1_000_000
  try {
    const offset = await initializeNetworkTime({
      timeServers: ['ntp-a'],
      queryNetworkTime: async (host, timeout) => {
        assert.equal(host, 'ntp-a')
        assert.equal(timeout, DEFAULT_NTP_TIMEOUT_MS)
        return {t: 1234.9}
      },
    })

    assert.equal(offset, 1234)
    assert.equal(getNetworkTimeOffsetMs(), 1234)
    assert.equal(networkNowMs(), 1_001_234)
  } finally {
    Date.now = realNow
  }
}

async function testFallbackToLaterServerWorks(): Promise<void> {
  resetNetworkTimeForTests()
  const queried: string[] = []

  const offset = await initializeNetworkTime({
    timeServers: ['ntp-a', 'ntp-b'],
    queryNetworkTime: async (host) => {
      queried.push(host)
      if (host === 'ntp-a') throw new Error('unreachable')
      return {t: -500}
    },
  })

  assert.deepEqual(queried, ['ntp-a', 'ntp-b'])
  assert.equal(offset, -500)
}

async function testOffsetBeyondLimitFails(): Promise<void> {
  resetNetworkTimeForTests()

  await assert.rejects(
    () =>
      initializeNetworkTime({
        timeServers: ['ntp-a'],
        queryNetworkTime: async () => ({t: 181_000}),
      }),
    /exceeds sync limit/,
  )
  assert.equal(getNetworkTimeOffsetMs(), 0)
}

async function testAllServersFailingFailsInitialization(): Promise<void> {
  resetNetworkTimeForTests()

  await assert.rejects(
    () =>
      initializeNetworkTime({
        timeServers: ['ntp-a', 'ntp-b'],
        queryNetworkTime: async () => {
          throw new Error('offline')
        },
      }),
    /Failed to initialize network time: offline/,
  )
}

async function main(): Promise<void> {
  await testValidOffsetIsApplied()
  await testFallbackToLaterServerWorks()
  await testOffsetBeyondLimitFails()
  await testAllServersFailingFailsInitialization()
  console.log('network time tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
