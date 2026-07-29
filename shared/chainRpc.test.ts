import assert from 'node:assert/strict'
import { assertCustomProviderCoverage } from './chainRpc'
import { isEthGetLogsRangeLimitError } from './lib/rpcUrls'

function testAssertCustomProviderCoveragePasses(): void {
  const chains = [{ chainId: 97 }, { chainId: 80002 }]
  const snapshot = new Map<number, unknown>([
    [97, [{ name: 'drpc', url: 'https://example.com' }]],
    [80002, [{ name: 'alchemy', url: 'https://example.com' }]],
  ])
  assert.doesNotThrow(() => assertCustomProviderCoverage(chains, snapshot))
}

function testAssertCustomProviderCoverageMissingChain(): void {
  const chains = [{ chainId: 97 }, { chainId: 80002 }]
  const snapshot = new Map<number, unknown>([
    [97, [{ name: 'drpc', url: 'https://example.com' }]],
  ])
  assert.throws(
    () => assertCustomProviderCoverage(chains, snapshot),
    /requires custom providers for chainId 80002/,
  )
}

function testAssertCustomProviderCoverageEmptyChains(): void {
  assert.throws(
    () => assertCustomProviderCoverage([], new Map()),
    /requires custom provider URLs for at least one configured chain/,
  )
}

function testDrpcEthGetLogsCode19IsRangeLimited(): void {
  assert.equal(
    isEthGetLogsRangeLimitError({
      code: 19,
      message: 'eth_getLogs: Temporary internal error. Please retry',
    }),
    true,
  )
}

function testDrpcUnrelatedCode19IsNotRangeLimited(): void {
  assert.equal(
    isEthGetLogsRangeLimitError({
      code: 19,
      message: 'Temporary internal error. Please retry',
    }),
    false,
  )
}

function run(): void {
  testAssertCustomProviderCoveragePasses()
  testAssertCustomProviderCoverageMissingChain()
  testAssertCustomProviderCoverageEmptyChains()
  testDrpcEthGetLogsCode19IsRangeLimited()
  testDrpcUnrelatedCode19IsNotRangeLimited()
  console.log('chainRpc tests passed')
}

run()
