import assert from 'node:assert/strict'
import {retryStartupRpcOperation} from './startupRetry'

function createTestLogger(): {messages: string[]; logger: Pick<Console, 'warn'>} {
  const messages: string[] = []
  return {
    messages,
    logger: {
      warn: (...args: unknown[]) => {
        messages.push(args.map(String).join(' '))
      },
    },
  }
}

async function testReturnsWithoutRetryOnFirstSuccess(): Promise<void> {
  let attempts = 0
  const sleeps: number[] = []
  const {messages, logger} = createTestLogger()

  const result = await retryStartupRpcOperation(
    'load nonce',
    async () => {
      attempts += 1
      return 42
    },
    {
      retryDelayMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      logger,
    },
  )

  assert.equal(result, 42)
  assert.equal(attempts, 1)
  assert.deepEqual(sleeps, [])
  assert.deepEqual(messages, [])
}

async function testRetriesUntilSuccess(): Promise<void> {
  let attempts = 0
  const sleeps: number[] = []
  const {messages, logger} = createTestLogger()

  const result = await retryStartupRpcOperation(
    'fetch bridge state',
    async () => {
      attempts += 1
      if (attempts < 3) throw new Error(`rpc unavailable ${attempts}`)
      return 'ready'
    },
    {
      retryDelayMs: 25,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      logger,
    },
  )

  assert.equal(result, 'ready')
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [25, 25])
  assert.equal(messages.length, 4)
  assert.match(messages[0], /Failed to fetch bridge state on attempt 1: rpc unavailable 1/)
  assert.match(messages[1], /Retrying fetch bridge state in 25ms/)
  assert.match(messages[2], /Failed to fetch bridge state on attempt 2: rpc unavailable 2/)
  assert.match(messages[3], /Retrying fetch bridge state in 25ms/)
}

async function main(): Promise<void> {
  await testReturnsWithoutRetryOnFirstSuccess()
  await testRetriesUntilSuccess()
  console.log('startup retry tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
