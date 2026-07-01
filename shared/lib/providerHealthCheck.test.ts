import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import axios from 'axios'
import {
  resolveCustomProviderConfigDir,
  resolveCustomProviderConfigPath,
} from './customProviders'
import {
  DEFAULT_HEALTH_CHECK_INTERVAL_HOURS,
  getFatalCustomProviderFailures,
  handleFatalCustomProviderFailures,
  parseEthBlockNumberResult,
  parseEthChainIdResult,
  pruneFailedProbeUrls,
  probeProviderUrl,
  resolveHealthCheckIntervalMs,
  runCustomProviderHealthCheck,
  runStartupProviderHealthCheck,
} from './providerHealthCheck'
import { addHttpUrls, getHttpUrls, removeHttpUrls } from './rpcUrls'

function testResolveCustomProviderConfigDirDefault(): void {
  const dir = resolveCustomProviderConfigDir(path.join(__dirname))
  assert.match(dir, /keystores[\\/]bnbtss$/)
}

function testResolveCustomProviderConfigDirEnvOverride(): void {
  const previous = process.env.BNB_TSS_HOME_ROOT
  const customHomeRoot = '/tmp/custom-bnbtss-home'
  process.env.BNB_TSS_HOME_ROOT = customHomeRoot
  try {
    assert.equal(resolveCustomProviderConfigDir(), path.resolve(customHomeRoot))
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

function testResolveCustomProviderConfigPathLegacyFallback(): void {
  const previous = process.env.BNB_TSS_HOME_ROOT
  delete process.env.BNB_TSS_HOME_ROOT
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-provider-path-'))
  const legacyPath = path.join(root, 'providers-bsc-testnet.json')

  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n')
    fs.writeFileSync(path.join(root, 'chain-config.json'), '{}\n')
    fs.writeFileSync(legacyPath, '{"chainId":97,"providers":[]}\n')
    assert.equal(resolveCustomProviderConfigPath(97, root), legacyPath)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    if (previous === undefined) {
      delete process.env.BNB_TSS_HOME_ROOT
    } else {
      process.env.BNB_TSS_HOME_ROOT = previous
    }
  }
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

function testParseEthChainIdResultValidHex(): void {
  assert.equal(parseEthChainIdResult('0x61', 97), 97)
  assert.equal(parseEthChainIdResult('0x13882', 80002), 80002)
}

function testParseEthChainIdResultMismatch(): void {
  assert.throws(
    () => parseEthChainIdResult('0x89', 80002),
    /eth_chainId mismatch: expected 80002, got 137/,
  )
}

function testParseEthChainIdResultInvalid(): void {
  assert.throws(() => parseEthChainIdResult(undefined, 97), /invalid result/)
  assert.throws(() => parseEthChainIdResult('not-hex', 97), /invalid result/)
}

function testRemoveHttpUrls(): void {
  addHttpUrls(97, ['https://good.example/rpc', 'https://bad.example/rpc'], {
    providerNames: ['good', 'bad'],
  })
  const removed = removeHttpUrls(97, ['https://bad.example/rpc'])
  assert.equal(removed, 1)
  assert.deepEqual(getHttpUrls(97), ['https://good.example/rpc'])
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

function testPruneFailedProbeUrls(): void {
  addHttpUrls(80002, ['https://good.example/rpc', 'https://bad.example/rpc'], {
    providerNames: ['good', 'bad'],
  })

  const removed = pruneFailedProbeUrls([
    {
      chainId: 80002,
      configuredCount: 2,
      healthyCount: 1,
      probes: [
        {
          name: 'good',
          url: 'https://good.example/rpc',
          pass: true,
          latencyMs: 1,
          blockNumber: 1,
        },
        {
          name: 'bad',
          url: 'https://bad.example/rpc',
          pass: false,
          latencyMs: 1,
          error: 'down',
        },
      ],
    },
  ])

  assert.equal(removed, 1)
  assert.deepEqual(getHttpUrls(80002), ['https://good.example/rpc'])
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
  assert.deepEqual(allFail, [{
    chainId: 97,
    configuredCount: 1,
    healthyCount: 0,
    probes: [{
      name: 'drpc',
      url: 'https://example.com/rpc',
      pass: false,
      latencyMs: 1,
      error: 'down',
    }],
  }])

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
  assert.deepEqual(onePass, [{
    chainId: 97,
    configuredCount: 1,
    healthyCount: 1,
    probes: [{
      name: 'drpc',
      url: 'https://example.com/rpc',
      pass: true,
      latencyMs: 1,
      blockNumber: 123,
    }],
  }])

  const emptySnapshot = await runCustomProviderHealthCheck(chains, () => [])
  assert.deepEqual(emptySnapshot, [{
    chainId: 97,
    configuredCount: 0,
    healthyCount: 0,
    probes: [],
  }])
}

async function testRunStartupProviderHealthCheckPrunesFailedUrls(): Promise<void> {
  addHttpUrls(137, ['https://keep.example/rpc', 'https://drop.example/rpc'], {
    providerNames: ['keep', 'drop'],
  })

  await runStartupProviderHealthCheck(
    [{ chainId: 137, name: 'Polygon Mainnet' }],
    () => [
      { name: 'keep', url: 'https://keep.example/rpc' },
      { name: 'drop', url: 'https://drop.example/rpc' },
    ],
    {
      rpcProviderMode: 'both',
      probeFn: async (entry) => ({
        name: entry.name,
        url: entry.url,
        pass: entry.name === 'keep',
        latencyMs: 1,
        blockNumber: entry.name === 'keep' ? 1 : undefined,
        error: entry.name === 'keep' ? undefined : 'down',
      }),
    },
  )

  assert.deepEqual(getHttpUrls(137), ['https://keep.example/rpc'])
}

async function testProbeProviderUrlPostsBatchJsonRpc(): Promise<void> {
  const originalPost = axios.post
  let postedBody: unknown

  axios.post = (async (_url: string, body: unknown) => {
    postedBody = body
    return {
      data: [
        { jsonrpc: '2.0', id: 1, result: '0x2a' },
        { jsonrpc: '2.0', id: 2, result: '0x61' },
      ],
    }
  }) as typeof axios.post

  try {
    const result = await probeProviderUrl(
      { name: 'http-rpc', url: 'https://rpc.example/eth' },
      97,
    )

    assert.ok(Array.isArray(postedBody))
    assert.equal((postedBody as Array<{ method: string }>)[0].method, 'eth_blockNumber')
    assert.equal((postedBody as Array<{ method: string }>)[1].method, 'eth_chainId')
    assert.equal(result.pass, true)
    assert.equal(result.blockNumber, 42)
  } finally {
    axios.post = originalPost
  }
}

async function testProbeProviderUrlFailsOnChainIdMismatch(): Promise<void> {
  const originalPost = axios.post

  axios.post = (async () => ({
    data: [
      { jsonrpc: '2.0', id: 1, result: '0x2a' },
      { jsonrpc: '2.0', id: 2, result: '0x89' },
    ],
  })) as typeof axios.post

  try {
    const result = await probeProviderUrl(
      { name: 'wrong-net', url: 'https://rpc.example/mainnet' },
      80002,
    )
    assert.equal(result.pass, false)
    assert.match(result.error ?? '', /eth_chainId mismatch/)
  } finally {
    axios.post = originalPost
  }
}

async function run(): Promise<void> {
  testResolveCustomProviderConfigDirDefault()
  testResolveCustomProviderConfigDirEnvOverride()
  testResolveCustomProviderConfigPath()
  testResolveCustomProviderConfigPathLegacyFallback()
  testResolveHealthCheckIntervalMsDefault()
  testResolveHealthCheckIntervalMsCustom()
  testParseEthBlockNumberResultValidHex()
  testParseEthBlockNumberResultInvalid()
  testParseEthChainIdResultValidHex()
  testParseEthChainIdResultMismatch()
  testParseEthChainIdResultInvalid()
  testRemoveHttpUrls()
  testGetFatalCustomProviderFailuresCustomMode()
  testGetFatalCustomProviderFailuresNonCustomModes()
  testHandleFatalCustomProviderFailures()
  testPruneFailedProbeUrls()
  await testRunCustomProviderHealthCheckOutcomes()
  await testRunStartupProviderHealthCheckPrunesFailedUrls()
  await testProbeProviderUrlPostsBatchJsonRpc()
  await testProbeProviderUrlFailsOnChainIdMismatch()
  console.log('providerHealthCheck tests passed')
}

void run()
