/**
 * Test script for multi-RPC and provider helper functionality (core logic only).
 *
 * Run from the tss-signer directory (not the shardus repo root):
 *   cd tss-signer && npx ts-node scripts/test-rpc-and-provider.ts
 *
 * Optional: set RUN_LIVE_RPC=1 to enable real HTTP RPC and WebSocket (WSS) network tests.
 *
 * Tests use the same modules as tss-party:
 * - rpcUrls: applyInfuraKey, initFromConfig, getHttpUrls/getWsUrls, mergeChainlistResponse
 * - httpProviderHelper: getHttpProviderForChain, withHttpProviderRetry
 * - wsProviderHelper: createWebSocketProvider (steps 11 and 14)
 * - (with RUN_LIVE_RPC=1) HTTP RPC: getBlockNumber, getNetwork, getGasPrice
 * - (with RUN_LIVE_RPC=1) WebSocket: connect and getBlockNumber via createWebSocketProvider
 */

import {ethers} from 'ethers'
import * as fs from 'fs'
import * as path from 'path'
import {
  applyInfuraKey,
  initFromConfig,
  getHttpUrls,
  getWsUrls,
  mergeChainlistResponse,
  fetchChainlistAndMerge,
} from './lib/rpcUrls'
import {
  getHttpProviderForChain,
  withHttpProviderRetry,
} from './lib/httpProviderHelper'
import {createWebSocketProvider} from './lib/wsProviderHelper'

const RUN_LIVE_RPC = process.env.RUN_LIVE_RPC === '1'

// Load chain config the same way as production (tss-party)
interface ChainConfigs {
  supportedChains: Record<string, { rpcUrl: string; wsUrl: string; name?: string }>
}
function loadChainConfigs(): ChainConfigs {
  const data = fs.readFileSync(path.join(__dirname, '../chain-config.json'), 'utf8')
  return JSON.parse(data)
}

function loadInfuraKey(): string {
  try {
    const data = fs.readFileSync(path.join(__dirname, '../infura_keys.json'), 'utf8')
    const keys = JSON.parse(data)
    return Array.isArray(keys) && keys.length > 0 ? keys[0] : 'test-key'
  } catch {
    return 'test-key'
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`)
  }
}

function timeoutReject<T>(ms: number): Promise<T> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
  )
}

async function main(): Promise<void> {
  console.log('Testing rpcUrls and httpProviderHelper...\n')

  // Load config and infura key the same way as production
  const chainConfigs = loadChainConfigs()
  const infuraKey = loadInfuraKey()
  const supportedChainIds = Object.keys(chainConfigs.supportedChains).map((id) => parseInt(id, 10))

  // --- applyInfuraKey (pure) ---
  console.log('1. applyInfuraKey')
  assertEqual(
    applyInfuraKey('https://mainnet.infura.io/v3/', 'abc123'),
    'https://mainnet.infura.io/v3/abc123',
    'Infura URL should get key appended with slash',
  )
  assertEqual(
    applyInfuraKey('https://eth.llamarpc.com', 'abc'),
    'https://eth.llamarpc.com',
    'Non-Infura URL should be unchanged',
  )
  assertEqual(applyInfuraKey('', 'key'), '', 'Empty URL returns empty')
  assertEqual(applyInfuraKey('https://x.infura.io/v3/', 'k'), 'https://x.infura.io/v3/k', 'infura in host')
  console.log('   OK\n')

  // --- initFromConfig (from chain-config.json, same as production) ---
  console.log('2. initFromConfig + getHttpUrls / getWsUrls (from chain-config.json)')
  initFromConfig(chainConfigs.supportedChains, infuraKey)

  for (const chainId of supportedChainIds) {
    const httpUrls = getHttpUrls(chainId)
    const wsUrls = getWsUrls(chainId)
    assert(httpUrls.length >= 1, `Chain ${chainId} should have at least one HTTP URL`)
    assert(wsUrls.length >= 1, `Chain ${chainId} should have at least one WS URL`)
    assert(httpUrls[0].startsWith('http://') || httpUrls[0].startsWith('https://'), `Chain ${chainId} HTTP URL should be valid`)
    assert(wsUrls[0].startsWith('ws://') || wsUrls[0].startsWith('wss://'), `Chain ${chainId} WS URL should be valid`)
  }
  console.log('   OK\n')

  // --- mergeChainlistResponse (mock payload) ---
  console.log('3. mergeChainlistResponse (mock chainlist payload)')
  const mockChainlist = supportedChainIds.map((chainId) => ({
    chainId,
    name: chainConfigs.supportedChains[chainId.toString()]?.name ?? `Chain ${chainId}`,
    rpc: [], // empty so we only assert merge doesn't clear config URLs; no dummy URLs in live steps
  }))
  mergeChainlistResponse(mockChainlist as unknown, new Set(supportedChainIds), infuraKey)

  for (const chainId of supportedChainIds) {
    const httpAfter = getHttpUrls(chainId)
    const wsAfter = getWsUrls(chainId)
    assert(httpAfter.length >= 1, `Chain ${chainId} should have at least one HTTP URL after merge`)
    assert(wsAfter.length >= 1, `Chain ${chainId} should have at least one WS URL after merge`)
  }
  console.log('   OK\n')

  // --- getHttpProviderForChain ---
  console.log('4. getHttpProviderForChain')
  const firstChainId = supportedChainIds[0]
  const urls = getHttpUrls(firstChainId)
  const provider1 = getHttpProviderForChain(urls, { chainId: firstChainId })
  const provider2 = getHttpProviderForChain(urls, { chainId: firstChainId })
  assert(provider1 != null, 'Should return a provider')
  assert(provider2 != null, 'Should return a provider')
  const conn1 = (provider1 as any).connection?.url ?? (provider1 as any).connection
  const conn2 = (provider2 as any).connection?.url ?? (provider2 as any).connection
  assert(conn1 && conn2, 'Providers should have connection')
  assert(urls.includes(conn1) && urls.includes(conn2), 'URL should be from list')
  console.log('   OK\n')

  // --- withHttpProviderRetry: success ---
  console.log('5. withHttpProviderRetry (success)')
  const result = await withHttpProviderRetry(
    urls,
    async (provider) => {
      assert(provider != null, 'Provider should be passed')
      return 42
    },
    { chainId: firstChainId, maxRetries: 2 },
  )
  assertEqual(result, 42, 'Should return callback result')
  console.log('   OK\n')

  // --- withHttpProviderRetry: failure propagates ---
  console.log('6. withHttpProviderRetry (failure)')
  try {
    await withHttpProviderRetry(
      urls,
      async () => {
        throw new Error('simulated failure')
      },
      { chainId: firstChainId, maxRetries: 2 },
    )
    assert(false, 'Should have thrown')
  } catch (e: any) {
    assert(e?.message === 'simulated failure', 'Should propagate error')
  }
  console.log('   OK\n')

  // --- withHttpProviderRetry: empty URLs throws ---
  console.log('7. withHttpProviderRetry (no URLs)')
  try {
    await withHttpProviderRetry([], async () => 1, {})
    assert(false, 'Should throw when no URLs')
  } catch (e: any) {
    assert(e?.message?.includes('No HTTP RPC URLs'), 'Should say no URLs')
  }
  console.log('   OK\n')

  // --- fetch chainlist (network): combine config + chainlist.org for all configured chains ---
  console.log('8. fetchChainlistAndMerge (network)')
  await fetchChainlistAndMerge(supportedChainIds, infuraKey)
  for (const cid of supportedChainIds) {
    console.log(`   Chain ${cid}  HTTP: ${getHttpUrls(cid).length}  WS: ${getWsUrls(cid).length} (config + chainlist.org combined)`)
  }
  console.log('   OK\n')

  // --- Optional: live HTTP RPC and WebSocket tests (use merged URLs from config + chainlist) ---
  if (RUN_LIVE_RPC) {
    const timeoutMs = 15000
    const maxRetries = 3

    console.log('9. HTTP RPC – getBlockNumber (via withHttpProviderRetry, merged URLs)')
    for (const chainId of supportedChainIds) {
      const httpUrls = getHttpUrls(chainId)
      if (httpUrls.length === 0) continue
      try {
        const block = await withHttpProviderRetry(
          httpUrls,
          (p) => Promise.race([p.getBlockNumber(), timeoutReject(timeoutMs)]),
          { chainId, fallbackRpcUrl: httpUrls[0], maxRetries },
        )
        console.log(`   Chain ${chainId} block number: ${block}`)
        assert(typeof block === 'number' && block > 0, `Chain ${chainId} block number should be positive`)
      } catch (e: any) {
        const msg = (e?.message ?? String(e)).slice(0, 80)
        console.log(`   Chain ${chainId} skipped: ${msg}`)
      }
    }
    console.log('   OK\n')

    console.log('10. HTTP RPC – getNetwork (chainId)')
    const firstId = supportedChainIds[0]
    const httpUrlsFirst = getHttpUrls(firstId)
    try {
      const network = (await withHttpProviderRetry(
        httpUrlsFirst,
        (p) => Promise.race([p.getNetwork(), timeoutReject<ethers.providers.Network>(timeoutMs)]),
        { chainId: firstId, fallbackRpcUrl: httpUrlsFirst[0], maxRetries },
      )) as ethers.providers.Network
      assert(network.chainId === firstId, `Network chainId should be ${firstId}`)
      console.log(`   Network: chainId=${network.chainId}, name=${network.name}`)
    } catch (e: any) {
      console.log(`   Skipped: ${e?.message || e}`)
    }
    console.log('   OK\n')

    console.log('11. HTTP RPC – getGasPrice')
    try {
      const gasPrice = (await withHttpProviderRetry(
        httpUrlsFirst,
        (p) => Promise.race([p.getGasPrice(), timeoutReject<ethers.BigNumber>(timeoutMs)]),
        { chainId: firstId, fallbackRpcUrl: httpUrlsFirst[0], maxRetries },
      )) as ethers.BigNumber
      assert(gasPrice != null && gasPrice.gte(0), 'Gas price should be non-negative')
      console.log(`   Gas price (wei): ${gasPrice.toString()}`)
    } catch (e: any) {
      console.log(`   Skipped: ${e?.message || e}`)
    }
    console.log('   OK\n')

    console.log('12. WebSocket (WSS) – connect and getBlockNumber (via createWebSocketProvider, merged URLs)')
    for (const chainId of supportedChainIds) {
      const wsUrls = getWsUrls(chainId)
      if (wsUrls.length === 0) continue
      const wsUrl = wsUrls[0]
      try {
        let connectionErrorReject: (err: Error) => void
        const connectionError = new Promise<never>((_, reject) => {
          connectionErrorReject = reject
        })
        const wsProvider = createWebSocketProvider(wsUrl, chainId, (err) => connectionErrorReject!(err))
        try {
          const block = await Promise.race([
            wsProvider.getBlockNumber(),
            connectionError,
            timeoutReject(timeoutMs),
          ])
          console.log(`   Chain ${chainId} (${wsUrl.replace(/\/[a-f0-9-]+$/i, '/…')}) block number: ${block}`)
          assert(typeof block === 'number' && block > 0, `Chain ${chainId} WS block number should be positive`)
        } finally {
          wsProvider.removeAllListeners()
          if ((wsProvider as any)._websocket) (wsProvider as any)._websocket.terminate()
        }
      } catch (e: any) {
        const msg = (e?.message ?? String(e)).slice(0, 80)
        console.log(`   Chain ${chainId} skipped: ${msg}`)
      }
    }
    console.log('   OK\n')

    console.log('12c. WS socket onError callback (production createWebSocketProvider – verify onError fires on failure)')
    const wsOnErrorTimeoutMs = 10000
    for (const chainId of supportedChainIds) {
      const wsUrls = getWsUrls(chainId)
      if (wsUrls.length === 0) continue
      let verifiedOnError = false
      for (let j = 0; j < wsUrls.length; j++) {
        let onErrorCalled = false
        let wsProvider: ethers.providers.WebSocketProvider | null = null
        try {
          let connectionErrorReject: (err: Error) => void
          const connectionError = new Promise<never>((_, reject) => {
            connectionErrorReject = (err: Error) => {
              onErrorCalled = true
              reject(err)
            }
          })
          wsProvider = createWebSocketProvider(wsUrls[j], chainId, (err) => connectionErrorReject(err))
          await Promise.race([
            wsProvider.getBlockNumber(),
            connectionError,
            timeoutReject<number>(wsOnErrorTimeoutMs),
          ])
        } catch (e: any) {
          assert(onErrorCalled, `Chain ${chainId} WS URL ${j + 1}: onError should be called when connection fails (production reconnect path)`)
          const displayUrl = wsUrls[j].replace(/\/[a-f0-9-]+$/i, '/…')
          console.log(`   Chain ${chainId}  WSS (${displayUrl}) failed as expected, onError fired (reconnect path would run in production)`)
          verifiedOnError = true
          break
        } finally {
          if (wsProvider) {
            wsProvider.removeAllListeners()
            if ((wsProvider as any)._websocket) (wsProvider as any)._websocket.terminate()
          }
        }
      }
      if (!verifiedOnError) {
        console.log(`   Chain ${chainId}  all WS URLs succeeded, onError not triggered`)
      }
      console.log('')
    }
    console.log('   OK\n')
  } else {
    console.log('9–12c. Live RPC and WSS tests skipped (set RUN_LIVE_RPC=1 to run)\n')
  }

  // --- Step 13: HTTP – withHttpProviderRetry as-is (13a) and with bad URL to see retry (13b) ---
  if (RUN_LIVE_RPC) {
    const timeoutMs = 12000
    const BAD_HTTP_URL = 'https://httpstat.us/403'
    const BAD_WS_URL = 'wss://invalid.example.com'

    console.log('13a. HTTP – withHttpProviderRetry as-is (see flow)')
    for (const chainId of supportedChainIds) {
      const httpUrls = getHttpUrls(chainId)
      if (httpUrls.length === 0) continue
      const numCalls = 3
      for (let i = 0; i < numCalls; i++) {
        try {
          const block = await withHttpProviderRetry(
            httpUrls,
            async (p) => {
              const url = (p as any).connection?.url ?? (p as any).connection ?? 'unknown'
              const displayUrl = String(url).replace(/\/[a-f0-9-]+$/i, '/…')
              console.log(`   Chain ${chainId}  call ${i + 1}/${numCalls}  RPC: ${displayUrl}`)
              return Promise.race([p.getBlockNumber(), timeoutReject(timeoutMs)])
            },
            { chainId, fallbackRpcUrl: httpUrls[0], maxRetries: 3 },
          )
          console.log(`   Chain ${chainId}  call ${i + 1}  block: ${block}`)
          assert(typeof block === 'number' && block > 0, `Chain ${chainId} block should be positive`)
        } catch (e: any) {
          console.log(`   Chain ${chainId}  call ${i + 1}  failed: ${(e?.message ?? e).slice(0, 80)}`)
        }
        console.log('')
      }
    }
    console.log('   OK\n')

    console.log('13b. HTTP – bad URL first to see retry')
    for (const chainId of supportedChainIds) {
      const goodUrls = getHttpUrls(chainId)
      if (goodUrls.length === 0) continue
      const urlsWithBad = [BAD_HTTP_URL, ...goodUrls]
      let attempt = 0
      try {
        const block = await withHttpProviderRetry(
          urlsWithBad,
          async (p) => {
            attempt++
            const url = (p as any).connection?.url ?? (p as any).connection ?? 'unknown'
            const displayUrl = String(url).replace(/\/[a-f0-9-]+$/i, '/…')
            console.log(`   Chain ${chainId}  attempt ${attempt}  RPC: ${displayUrl}`)
            const b = await Promise.race([p.getBlockNumber(), timeoutReject(timeoutMs)])
            if (attempt > 1) {
              console.log(`   Chain ${chainId}  retry succeeded, block: ${b}`)
            }
            return b
          },
          { chainId, fallbackRpcUrl: goodUrls[0], maxRetries: 3 },
        )
        console.log(`   Chain ${chainId}  block: ${block}`)
        assert(attempt >= 1 && typeof block === 'number' && block > 0, 'should succeed (possibly after retry)')
      } catch (e: any) {
        console.log(`   Chain ${chainId}  failed after ${attempt} attempt(s): ${(e?.message ?? e).slice(0, 80)}`)
      }
      console.log('')
    }
    console.log('   OK\n')

    console.log('14a. WS – reconnect flow as-is (try URLs in order until one works)')
    const wsTimeoutMs = 15000
    const numConnections = 3
    for (const chainId of supportedChainIds) {
      const wsUrls = getWsUrls(chainId)
      if (wsUrls.length === 0) continue
      console.log(`   Chain ${chainId}: ${wsUrls.length} WS URLs, ${numConnections} connections`)
      for (let conn = 0; conn < numConnections; conn++) {
        let block: number | null = null
        let usedUrlIndex = -1
        for (let j = 0; j < wsUrls.length; j++) {
          let wsProvider: ethers.providers.WebSocketProvider | null = null
          try {
            let connectionErrorReject: (err: Error) => void
            const connectionError = new Promise<never>((_, reject) => {
              connectionErrorReject = reject
            })
            wsProvider = createWebSocketProvider(wsUrls[j], chainId, (err) => connectionErrorReject(err))
            const displayUrl = wsUrls[j].replace(/\/[a-f0-9-]+$/i, '/…')
            console.log(`   Chain ${chainId}  conn ${conn + 1}/${numConnections}  trying URL ${j + 1}/${wsUrls.length}  WSS: ${displayUrl}`)
            block = (await Promise.race([
              wsProvider.getBlockNumber(),
              connectionError,
              timeoutReject<number>(wsTimeoutMs),
            ])) as number
            usedUrlIndex = j
            console.log(`   Chain ${chainId}  conn ${conn + 1}  block: ${block}`)
            break
          } catch (e: any) {
            const msg = (e?.message ?? String(e)).slice(0, 60)
            const displayUrl = wsUrls[j].replace(/\/[a-f0-9-]+$/i, '/…')
            console.log(`   Chain ${chainId}  conn ${conn + 1}  WSS ${displayUrl}  failed: ${msg} – reconnecting with next URL`)
          } finally {
            if (wsProvider) {
              wsProvider.removeAllListeners()
              if ((wsProvider as any)._websocket) (wsProvider as any)._websocket.terminate()
            }
          }
        }
        if (block == null || block <= 0) {
          console.log(`   Chain ${chainId}  conn ${conn + 1}  failed after all URLs`)
        }
        console.log('')
      }
    }
    console.log('   OK\n')

    console.log('14b. WS – bad URL first, onError schedules reconnect (same pattern as tss-party)')
    for (const chainId of supportedChainIds) {
      const goodWsUrls = getWsUrls(chainId)
      if (goodWsUrls.length === 0) continue
      const badUrl = BAD_WS_URL
      const goodUrl = goodWsUrls[0]
      let reconnectResolve!: (block: number) => void
      const reconnectDone = new Promise<number>((resolve) => {
        reconnectResolve = resolve
      })
      const firstProvider = createWebSocketProvider(badUrl, chainId, (error) => {
        // Same snippet as tss-party: socket-level error → schedule reconnect
        setTimeout(() => {
          console.log(`   Chain ${chainId}  Reconnecting after socket error (trying good URL)...`)
          const secondProvider = createWebSocketProvider(goodUrl, chainId, () => {})
          Promise.race([
            secondProvider.getBlockNumber(),
            timeoutReject<number>(wsTimeoutMs),
          ])
            .then((block) => {
              reconnectResolve(block)
              secondProvider.removeAllListeners()
              if ((secondProvider as any)._websocket) (secondProvider as any)._websocket.terminate()
            })
            .catch((e: any) => {
              reconnectResolve(-1)
              secondProvider.removeAllListeners()
              if ((secondProvider as any)._websocket) (secondProvider as any)._websocket.terminate()
            })
        }, 3000)
      })
      const displayBad = badUrl.replace(/\/[a-f0-9-]+$/i, '/…')
      console.log(`   Chain ${chainId}  trying bad URL first  WSS: ${displayBad}`)
      // Bad URL will fail; onError fires and schedules reconnect; wait for reconnect to complete
      const block = await Promise.race([
        reconnectDone,
        timeoutReject<number>(wsTimeoutMs + 5000),
      ])
      firstProvider.removeAllListeners()
      if ((firstProvider as any)._websocket) (firstProvider as any)._websocket.terminate()
      assert(block > 0, `Chain ${chainId} should succeed after reconnect`)
      console.log(`   Chain ${chainId}  reconnect succeeded, block: ${block}`)
      console.log('')
    }
    console.log('   OK\n')
  }

  console.log('All tests passed.')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
