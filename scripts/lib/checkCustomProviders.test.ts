import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import axios from 'axios'
import { probeProviderUrl } from '../../shared/lib/providerHealthCheck'
import {
  DEFAULT_PROVIDER_PROBE_FN,
  runProviderCheck,
} from './checkCustomProviders'

type ConsoleMethod = (...args: unknown[]) => void

async function captureConsole(
  fn: () => void | Promise<void>,
): Promise<{ logs: string[]; errors: string[] }> {
  const logs: string[] = []
  const errors: string[] = []
  const originalLog = console.log
  const originalError = console.error

  console.log = ((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '))
  }) as ConsoleMethod
  console.error = ((...args: unknown[]) => {
    errors.push(args.map((arg) => String(arg)).join(' '))
  }) as ConsoleMethod

  try {
    await fn()
  } finally {
    console.log = originalLog
    console.error = originalError
  }

  return { logs, errors }
}

function testDefaultProbeFnIsHttpProbeProviderUrl(): void {
  assert.equal(DEFAULT_PROVIDER_PROBE_FN, probeProviderUrl)
}

function testCheckCustomProvidersModuleDoesNotImportEthers(): void {
  const modulePath = path.join(__dirname, 'checkCustomProviders.js')
  const source = fs.readFileSync(modulePath, 'utf8')
  assert.doesNotMatch(source, /require\(['"]ethers['"]\)/)
  assert.doesNotMatch(source, /from ['"]ethers['"]/)
  assert.match(source, /providerHealthCheck/)
}

async function testRunProviderCheckUsesInjectedProbeFn(): Promise<void> {
  const chains = [{ chainId: 97, name: 'BSC Testnet' }]
  const probed: Array<{ name: string; url: string; chainId: number }> = []

  const { logs } = await captureConsole(async () => {
    await runProviderCheck(chains, 'check-custom-providers-dev', {
      loadUrls: () => ({
        resolved: [{ name: 'mock-rpc', url: 'https://rpc.example/v1' }],
        skipped: [],
      }),
      probeFn: async (entry, chainId) => {
        probed.push({ name: entry.name, url: entry.url, chainId })
        return {
          name: entry.name,
          url: entry.url,
          pass: true,
          latencyMs: 3,
          blockNumber: 42,
        }
      },
    })
  })

  assert.equal(probed.length, 1)
  assert.deepEqual(probed[0], {
    name: 'mock-rpc',
    url: 'https://rpc.example/v1',
    chainId: 97,
  })
  assert.ok(
    logs.some((line) => line.includes('HTTP JSON-RPC eth_blockNumber')),
    'expected HTTP probe banner in logs',
  )
  assert.ok(
    logs.some((line) => line.includes('block=42')),
    'expected block number from injected probe result',
  )
}

async function testRunProviderCheckExitsOnProbeFailure(): Promise<void> {
  const chains = [{ chainId: 137, name: 'Polygon Mainnet' }]
  let exitCode: number | undefined
  const originalExit = process.exit

  process.exit = ((code?: number) => {
    exitCode = code
    throw new Error(`process.exit(${code})`)
  }) as typeof process.exit

  try {
    await captureConsole(async () => {
      await runProviderCheck(chains, 'check-custom-providers', {
        loadUrls: () => ({
          resolved: [{ name: 'down-rpc', url: 'https://rpc.example/down' }],
          skipped: [],
        }),
        probeFn: async (entry) => ({
          name: entry.name,
          url: entry.url,
          pass: false,
          latencyMs: 1,
          error: 'connection refused',
        }),
      })
    })
  } catch (err) {
    assert.match((err as Error).message, /process\.exit\(1\)/)
  } finally {
    process.exit = originalExit
  }

  assert.equal(exitCode, 1)
}

async function testProbeProviderUrlPostsEthBlockNumberViaHttp(): Promise<void> {
  const originalPost = axios.post
  let postedUrl: string | undefined
  let postedBody: unknown

  axios.post = (async (url: string, body: unknown) => {
    postedUrl = url
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

    assert.equal(postedUrl, 'https://rpc.example/eth')
    assert.ok(Array.isArray(postedBody))
    assert.equal((postedBody as Array<{ method: string }>)[0].method, 'eth_blockNumber')
    assert.equal((postedBody as Array<{ method: string }>)[1].method, 'eth_chainId')
    assert.equal(result.pass, true)
    assert.equal(result.blockNumber, 42)
  } finally {
    axios.post = originalPost
  }
}

async function run(): Promise<void> {
  testDefaultProbeFnIsHttpProbeProviderUrl()
  testCheckCustomProvidersModuleDoesNotImportEthers()
  await testRunProviderCheckUsesInjectedProbeFn()
  await testRunProviderCheckExitsOnProbeFailure()
  await testProbeProviderUrlPostsEthBlockNumberViaHttp()
  console.log('checkCustomProviders tests passed')
}

void run()
