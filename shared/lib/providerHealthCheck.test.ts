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
import {
  buildTssProviderAlertPayload,
  classifyTssProviderHealth,
  sendTssProviderAlert,
} from './tssProviderAlert'
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
    chainName: 'BSC Testnet',
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
    chainName: 'BSC Testnet',
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
    chainName: 'BSC Testnet',
    configuredCount: 0,
    healthyCount: 0,
    probes: [],
  }])
}

function testTssProviderAlertClassification(): void {
  assert.equal(classifyTssProviderHealth(4, 10), 'warning')
  assert.equal(classifyTssProviderHealth(2, 10), 'emergency')
  assert.equal(classifyTssProviderHealth(5, 10), null)
  assert.equal(classifyTssProviderHealth(0, 0), null)
}

function testTssProviderAlertSanitization(): void {
  const payload = buildTssProviderAlertPayload(
    [{
      chainId: 97,
      chainName: 'BSC Testnet',
      configuredCount: 5,
      healthyCount: 2,
      probes: [
        { name: 'alchemy', url: 'https://alchemy.example/key', pass: false, latencyMs: 1, error: 'down' },
        { name: 'https://leak.example/key', url: 'https://leak.example/key', pass: false, latencyMs: 1, error: 'down' },
        { name: 'verylongapikeyvalue12345678901234567890', url: 'https://key.example/rpc', pass: false, latencyMs: 1, error: 'down' },
        { name: 'healthy', url: 'https://healthy.example/rpc', pass: true, latencyMs: 1, blockNumber: 1 },
      ],
    }],
    { instanceId: 'tss-1', hostname: 'host-1', generatedAt: '2026-07-08T20:00:00.000Z' },
  )

  assert.ok(payload)
  assert.deepEqual(payload.chains[0].failedProviders, ['alchemy'])
  assert.equal(JSON.stringify(payload).includes('https://'), false)
  assert.equal(JSON.stringify(payload).includes('verylongapikeyvalue'), false)
  assert.equal(JSON.stringify(payload).includes('healthy'), false)
}

async function testSendTssProviderAlert(): Promise<void> {
  const warningPayload = buildTssProviderAlertPayload(
    [{
      chainId: 97,
      chainName: 'BSC Testnet',
      configuredCount: 10,
      healthyCount: 4,
      probes: [
        { name: 'alchemy', url: 'https://alchemy.example/rpc', pass: false, latencyMs: 1, error: 'down' },
      ],
    }],
    { instanceId: 'tss-1', hostname: 'host-1', generatedAt: '2026-07-08T20:00:00.000Z' },
  )
  let postedUrl = ''
  let postedHeaders: Record<string, string> = {}
  const originalLog = console.log
  const logs: string[] = []
  console.log = (message?: unknown) => logs.push(String(message))
  let sent: boolean
  try {
    sent = await sendTssProviderAlert(warningPayload, {
      statusServerBaseUrl: 'http://status-server:6969/',
      token: 'shared-secret',
      post: (async (url: string, _body: unknown, options: { headers: Record<string, string> }) => {
        postedUrl = url
        postedHeaders = options.headers
        return { data: { ok: true } }
      }) as typeof axios.post,
    })
  } finally {
    console.log = originalLog
  }
  assert.equal(sent, true)
  assert.deepEqual(logs, [
    '[tssProviderAlert] Discord alert preview: severity=warning; BSC Testnet (97): 4/10 active (40%) severity=warning failedProviders=alchemy',
    '[tssProviderAlert] Attempting Discord alert delivery via status-server for 1 chain(s)',
  ])
  assert.equal(postedUrl, 'http://status-server:6969/api/tss-provider-health/alert')
  assert.equal(postedHeaders.Authorization, 'Bearer shared-secret')

  const healthyPayload = buildTssProviderAlertPayload([{
    chainId: 97,
    chainName: 'BSC Testnet',
    configuredCount: 10,
    healthyCount: 5,
    probes: [],
  }])
  assert.equal(healthyPayload, null)
  assert.equal(await sendTssProviderAlert(healthyPayload, {
    statusServerBaseUrl: 'http://status-server:6969',
    token: 'shared-secret',
    post: (async () => {
      throw new Error('should not post')
    }) as typeof axios.post,
  }), false)
}

async function testSendTssProviderAlertLogsMissingConfiguration(): Promise<void> {
  const payload = buildTssProviderAlertPayload(
    [{
      chainId: 97,
      chainName: 'BSC Testnet',
      configuredCount: 4,
      healthyCount: 1,
      probes: [],
    }],
    { instanceId: 'tss-1', hostname: 'host-1' },
  )
  const previousBaseUrl = process.env.STATUS_SERVER_BASE_URL
  const previousToken = process.env.TSS_PROVIDER_ALERT_TOKEN
  const originalWarn = console.warn
  const originalLog = console.log
  const warnings: string[] = []
  const logs: string[] = []
  delete process.env.STATUS_SERVER_BASE_URL
  delete process.env.TSS_PROVIDER_ALERT_TOKEN
  console.warn = (message?: unknown) => warnings.push(String(message))
  console.log = (message?: unknown) => logs.push(String(message))

  try {
    assert.equal(await sendTssProviderAlert(payload), false)
    assert.deepEqual(logs, [
      '[tssProviderAlert] Discord alert preview: severity=warning; BSC Testnet (97): 1/4 active (25%) severity=warning failedProviders=(none reported)',
    ])
    assert.deepEqual(warnings, [
      '[tssProviderAlert] Skipped Discord alert delivery: missing STATUS_SERVER_BASE_URL, TSS_PROVIDER_ALERT_TOKEN',
    ])
  } finally {
    console.warn = originalWarn
    console.log = originalLog
    if (previousBaseUrl === undefined) delete process.env.STATUS_SERVER_BASE_URL
    else process.env.STATUS_SERVER_BASE_URL = previousBaseUrl
    if (previousToken === undefined) delete process.env.TSS_PROVIDER_ALERT_TOKEN
    else process.env.TSS_PROVIDER_ALERT_TOKEN = previousToken
  }
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

async function testRunStartupProviderHealthCheckSendsInitialAlert(): Promise<void> {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    name: `provider-${index}`,
    url: `https://provider-${index}.example/rpc`,
  }))
  const sentPayloads: unknown[] = []

  await runStartupProviderHealthCheck(
    [{ chainId: 97, name: 'BSC Testnet' }],
    () => entries,
    {
      rpcProviderMode: 'both',
      probeFn: async (entry) => ({
        name: entry.name,
        url: entry.url,
        pass: entry.name.endsWith('-0') || entry.name.endsWith('-1'),
        latencyMs: 1,
      }),
      sendAlert: async (payload) => {
        sentPayloads.push(payload)
        return true
      },
    },
  )

  assert.equal(sentPayloads.length, 1)
  const payload = sentPayloads[0] as { chains: Array<{ severity: string }> }
  assert.equal(payload.chains[0].severity, 'warning')
}

async function testFatalProviderHealthAlertIsAttemptedBeforeExit(): Promise<void> {
  const events: string[] = []

  await runStartupProviderHealthCheck(
    [{ chainId: 97, name: 'BSC Testnet' }],
    () => [{ name: 'provider-0', url: 'https://provider-0.example/rpc' }],
    {
      rpcProviderMode: 'custom',
      probeFn: async (entry) => ({
        name: entry.name,
        url: entry.url,
        pass: false,
        latencyMs: 1,
        error: 'down',
      }),
      sendAlert: async (payload) => {
        assert.equal(payload?.chains[0].severity, 'emergency')
        events.push('alert')
        return true
      },
      exit: (code) => {
        assert.equal(code, 1)
        events.push('exit')
      },
    },
  )

  assert.deepEqual(events, ['alert', 'exit'])
}

async function testFatalProviderHealthExitRunsWhenAlertFails(): Promise<void> {
  const events: string[] = []

  await runStartupProviderHealthCheck(
    [{ chainId: 97, name: 'BSC Testnet' }],
    () => [{ name: 'provider-0', url: 'https://provider-0.example/rpc' }],
    {
      rpcProviderMode: 'custom',
      probeFn: async (entry) => ({
        name: entry.name,
        url: entry.url,
        pass: false,
        latencyMs: 1,
        error: 'down',
      }),
      sendAlert: async () => {
        events.push('alert')
        throw new Error('status server unavailable')
      },
      exit: () => events.push('exit'),
    },
  )

  assert.deepEqual(events, ['alert', 'exit'])
}

async function testNonFatalStartupAlertFailureDoesNotReject(): Promise<void> {
  await runStartupProviderHealthCheck(
    [{ chainId: 97, name: 'BSC Testnet' }],
    () => [{ name: 'provider-0', url: 'https://provider-0.example/rpc' }],
    {
      rpcProviderMode: 'both',
      probeFn: async (entry) => ({
        name: entry.name,
        url: entry.url,
        pass: false,
        latencyMs: 1,
        error: 'down',
      }),
      sendAlert: async () => {
        throw new Error('status server unavailable')
      },
      exit: () => assert.fail('non-custom mode must not exit'),
    },
  )
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
  testTssProviderAlertClassification()
  testTssProviderAlertSanitization()
  await testRunCustomProviderHealthCheckOutcomes()
  await testRunStartupProviderHealthCheckPrunesFailedUrls()
  await testRunStartupProviderHealthCheckSendsInitialAlert()
  await testFatalProviderHealthAlertIsAttemptedBeforeExit()
  await testFatalProviderHealthExitRunsWhenAlertFails()
  await testNonFatalStartupAlertFailureDoesNotReject()
  await testProbeProviderUrlPostsBatchJsonRpc()
  await testProbeProviderUrlFailsOnChainIdMismatch()
  await testSendTssProviderAlert()
  await testSendTssProviderAlertLogsMissingConfiguration()
  console.log('providerHealthCheck tests passed')
}

void run()
