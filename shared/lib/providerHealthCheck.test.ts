import assert from 'node:assert/strict'
import path from 'node:path'
import {
  resolveCustomProviderConfigDir,
  resolveCustomProviderConfigPath,
} from './customProviders'
import {
  DEFAULT_HEALTH_CHECK_INTERVAL_HOURS,
  getFatalCustomProviderFailures,
  handleFatalCustomProviderFailures,
  parseEthBlockNumberResult,
  resolveHealthCheckIntervalMs,
  runCustomProviderHealthCheck,
} from './providerHealthCheck'

function testResolveCustomProviderConfigDirDefault(): void {
  const dir = resolveCustomProviderConfigDir(path.join(__dirname))
  assert.match(dir, /keystores[\\/]bnbtss$/)
}

function testResolveCustomProviderConfigDirEnvOverride(): void {
  const previous = process.env.BNB_TSS_HOME_ROOT
  process.env.BNB_TSS_HOME_ROOT = '/tmp/custom-bnbtss-home'
  try {
    assert.equal(resolveCustomProviderConfigDir(), '/tmp/custom-bnbtss-home')
  } finally {
    if (previous === undefined) {
      delete process.env.BNB_TSS_HOME_ROOT
    } else {
      process.env.BNB_TSS_HOME_ROOT = previous
    }
  }
}

function testResolveCustomProviderConfigPath(): void {
  const filePath = resolveCustomProviderConfigPath(97, path.join(__dirname))
  assert.match(filePath, /providers-bsc-testnet\.json$/)
}

function testResolveHealthCheckIntervalMsDefault(): void {
  assert.equal(
    resolveHealthCheckIntervalMs(),
    DEFAULT_HEALTH_CHECK_INTERVAL_HOURS * 60 * 60 * 1000,
  )
}

function testResolveHealthCheckIntervalMsCustom(): void {
  assert.equal(resolveHealthCheckIntervalMs(12), 12 * 60 * 60 * 1000)
}

function testParseEthBlockNumberResultValidHex(): void {
  assert.equal(parseEthBlockNumberResult('0x5f5e100'), 100000000)
  assert.equal(parseEthBlockNumberResult('0x0'), 0)
}

function testParseEthBlockNumberResultInvalid(): void {
  assert.throws(() => parseEthBlockNumberResult(undefined), /invalid result/)
  assert.throws(() => parseEthBlockNumberResult('12345'), /invalid result/)
  assert.throws(() => parseEthBlockNumberResult('0x'), /invalid result/)
}

function testGetFatalCustomProviderFailuresCustomMode(): void {
  const allFail = getFatalCustomProviderFailures(
    [{ chainId: 97, configuredCount: 3, healthyCount: 0 }],
    'custom',
  )
  assert.equal(allFail.length, 1)
  assert.match(allFail[0], /chainId=97/)

  const noneConfigured = getFatalCustomProviderFailures(
    [{ chainId: 97, configuredCount: 0, healthyCount: 0 }],
    'custom',
  )
  assert.equal(noneConfigured.length, 1)
  assert.match(noneConfigured[0], /no custom providers configured/)

  const oneHealthy = getFatalCustomProviderFailures(
    [{ chainId: 97, configuredCount: 3, healthyCount: 1 }],
    'custom',
  )
  assert.equal(oneHealthy.length, 0)
}

function testGetFatalCustomProviderFailuresNonCustomModes(): void {
  const outcomes = [{ chainId: 97, configuredCount: 3, healthyCount: 0 }]
  assert.deepEqual(getFatalCustomProviderFailures(outcomes, 'both'), [])
  assert.deepEqual(getFatalCustomProviderFailures(outcomes, 'chainlist'), [])
}

function testHandleFatalCustomProviderFailures(): void {
  let exitCode: number | undefined
  handleFatalCustomProviderFailures([], (code) => {
    exitCode = code
  })
  assert.equal(exitCode, undefined)

  let fatalCode: number | undefined
  handleFatalCustomProviderFailures(['chainId=97: boom'], (code) => {
    fatalCode = code
  })
  assert.equal(fatalCode, 1)
}

async function testRunCustomProviderHealthCheckOutcomes(): Promise<void> {
  const chains = [{ chainId: 97, name: 'BSC Testnet' }]
  const entries = [{ name: 'drpc', url: 'https://example.com/rpc' }]

  const allFail = await runCustomProviderHealthCheck(
    chains,
    () => entries,
    {
      probeFn: async (entry) => ({
        name: entry.name,
        url: entry.url,
        pass: false,
        latencyMs: 1,
        error: 'down',
      }),
    },
  )
  assert.deepEqual(allFail, [{ chainId: 97, configuredCount: 1, healthyCount: 0 }])

  const onePass = await runCustomProviderHealthCheck(
    chains,
    () => entries,
    {
      probeFn: async (entry) => ({
        name: entry.name,
        url: entry.url,
        pass: true,
        latencyMs: 1,
        blockNumber: 123,
      }),
    },
  )
  assert.deepEqual(onePass, [{ chainId: 97, configuredCount: 1, healthyCount: 1 }])

  const emptySnapshot = await runCustomProviderHealthCheck(chains, () => [])
  assert.deepEqual(emptySnapshot, [{ chainId: 97, configuredCount: 0, healthyCount: 0 }])
}

async function run(): Promise<void> {
  testResolveCustomProviderConfigDirDefault()
  testResolveCustomProviderConfigDirEnvOverride()
  testResolveCustomProviderConfigPath()
  testResolveHealthCheckIntervalMsDefault()
  testResolveHealthCheckIntervalMsCustom()
  testParseEthBlockNumberResultValidHex()
  testParseEthBlockNumberResultInvalid()
  testGetFatalCustomProviderFailuresCustomMode()
  testGetFatalCustomProviderFailuresNonCustomModes()
  testHandleFatalCustomProviderFailures()
  await testRunCustomProviderHealthCheckOutcomes()
  console.log('providerHealthCheck tests passed')
}

void run()
