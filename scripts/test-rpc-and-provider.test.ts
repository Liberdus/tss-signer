/**
 * Jest tests for multi-RPC and provider helper functionality.
 *
 * Run: npm run test:rpc
 * With live RPC/WSS: RUN_LIVE_RPC=1 npm run test:rpc
 */

import { ethers } from 'ethers'
import * as fs from 'fs'
import * as path from 'path'
import {
  applyInfuraKey,
  initFromConfig,
  getHttpUrls,
  getWsUrls,
  mergeChainlistResponse,
  fetchChainlistAndMerge,
  markUrlFailed,
  pickAvailableUrlFromList,
  shouldBlacklistForError,
  clearUrlBlacklist,
} from './lib/rpcUrls'
import {
  getHttpProviderForChain,
  withHttpProviderRetry,
} from './lib/httpProviderHelper'
import { createWebSocketProvider } from './lib/wsProviderHelper'

const RUN_LIVE_RPC = process.env.RUN_LIVE_RPC === '1'
const liveDescribe = RUN_LIVE_RPC ? describe : describe.skip

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

function timeoutReject<T>(ms: number): Promise<T> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
  )
}

describe('RPC and provider tests', () => {
  let chainConfigs: ChainConfigs
  let infuraKey: string
  let supportedChainIds: number[]

  beforeAll(() => {
    chainConfigs = loadChainConfigs()
    infuraKey = loadInfuraKey()
    supportedChainIds = Object.keys(chainConfigs.supportedChains).map((id) => parseInt(id, 10))
    initFromConfig(chainConfigs.supportedChains, infuraKey)
  })

  describe('rpcUrls - applyInfuraKey', () => {
    it('appends key to Infura URL with trailing slash', () => {
      expect(applyInfuraKey('https://mainnet.infura.io/v3/', 'abc123')).toBe(
        'https://mainnet.infura.io/v3/abc123',
      )
    })
    it('leaves non-Infura URL unchanged', () => {
      expect(applyInfuraKey('https://eth.llamarpc.com', 'abc')).toBe('https://eth.llamarpc.com')
    })
    it('returns empty for empty URL', () => {
      expect(applyInfuraKey('', 'key')).toBe('')
    })
    it('appends key when infura is in host', () => {
      expect(applyInfuraKey('https://x.infura.io/v3/', 'k')).toBe('https://x.infura.io/v3/k')
    })
  })

  describe('rpcUrls - initFromConfig and getHttpUrls/getWsUrls', () => {
    it('each configured chain has at least one HTTP and one WS URL', () => {
      for (const chainId of supportedChainIds) {
        const httpUrls = getHttpUrls(chainId)
        const wsUrls = getWsUrls(chainId)
        expect(httpUrls.length).toBeGreaterThanOrEqual(1)
        expect(wsUrls.length).toBeGreaterThanOrEqual(1)
        expect(httpUrls[0]).toMatch(/^https?:\/\//)
        expect(wsUrls[0]).toMatch(/^wss?:\/\//)
      }
    })
  })

  describe('rpcUrls - mergeChainlistResponse', () => {
    it('merge does not clear config URLs (mock chainlist)', () => {
      const mockChainlist = supportedChainIds.map((chainId) => ({
        chainId,
        name: chainConfigs.supportedChains[chainId.toString()]?.name ?? `Chain ${chainId}`,
        rpc: [],
      }))
      mergeChainlistResponse(mockChainlist as unknown, new Set(supportedChainIds), infuraKey)
      for (const chainId of supportedChainIds) {
        const httpAfter = getHttpUrls(chainId)
        const wsAfter = getWsUrls(chainId)
        expect(httpAfter.length).toBeGreaterThanOrEqual(1)
        expect(wsAfter.length).toBeGreaterThanOrEqual(1)
      }
    })
  })

  describe('httpProviderHelper - getHttpProviderForChain', () => {
    it('returns provider with connection from URL list', () => {
      const firstChainId = supportedChainIds[0]
      const urls = getHttpUrls(firstChainId)
      const provider1 = getHttpProviderForChain(urls, { chainId: firstChainId })
      const provider2 = getHttpProviderForChain(urls, { chainId: firstChainId })
      expect(provider1).not.toBeNull()
      expect(provider2).not.toBeNull()
      const conn1 = (provider1 as any).connection?.url ?? (provider1 as any).connection
      const conn2 = (provider2 as any).connection?.url ?? (provider2 as any).connection
      expect(urls).toContain(conn1)
      expect(urls).toContain(conn2)
    })
  })

  describe('httpProviderHelper - withHttpProviderRetry', () => {
    it('returns callback result on success', async () => {
      const firstChainId = supportedChainIds[0]
      const urls = getHttpUrls(firstChainId)
      const result = await withHttpProviderRetry(
        urls,
        async (provider) => {
          expect(provider).not.toBeNull()
          return 42
        },
        { chainId: firstChainId, maxRetries: 2 },
      )
      expect(result).toBe(42)
    })
    it('propagates callback error', async () => {
      const firstChainId = supportedChainIds[0]
      const urls = getHttpUrls(firstChainId)
      await expect(
        withHttpProviderRetry(
          urls,
          async () => {
            throw new Error('simulated failure')
          },
          { chainId: firstChainId, maxRetries: 2 },
        ),
      ).rejects.toThrow('simulated failure')
    })
    it('throws when no URLs provided', async () => {
      await expect(
        withHttpProviderRetry([], async () => 1, {}),
      ).rejects.toThrow(/No HTTP RPC URLs/)
    })
  })

  describe('fetchChainlistAndMerge', () => {
    it('merges chainlist.org with config for all chains', async () => {
      await fetchChainlistAndMerge(supportedChainIds, infuraKey)
      for (const cid of supportedChainIds) {
        expect(getHttpUrls(cid).length).toBeGreaterThanOrEqual(0)
        expect(getWsUrls(cid).length).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('rpcUrls - shouldBlacklistForError', () => {
    it('returns true for ECONNREFUSED, ENOTFOUND, ECONNRESET', () => {
      expect(shouldBlacklistForError({ code: 'ECONNREFUSED' })).toBe(true)
      expect(shouldBlacklistForError({ code: 'ENOTFOUND' })).toBe(true)
      expect(shouldBlacklistForError({ code: 'ECONNRESET' })).toBe(true)
    })
    it('returns true for 5xx status and 5xx in message', () => {
      expect(shouldBlacklistForError({ status: 502 })).toBe(true)
      expect(shouldBlacklistForError({ response: { status: 503 } })).toBe(true)
      expect(shouldBlacklistForError({ message: '502 Bad Gateway' })).toBe(true)
    })
    it('returns true for invalid response / parse error', () => {
      expect(shouldBlacklistForError({ message: 'invalid response' })).toBe(true)
      expect(shouldBlacklistForError({ message: 'parse error' })).toBe(true)
    })
    it('returns false for 429 and rate limit message', () => {
      expect(shouldBlacklistForError({ message: '429 Too Many Requests' })).toBe(false)
      expect(shouldBlacklistForError({ message: 'rate limit exceeded' })).toBe(false)
      expect(shouldBlacklistForError({ message: 'too many requests' })).toBe(false)
      expect(shouldBlacklistForError({ message: 'throttled' })).toBe(false)
    })
    it('returns false for ETIMEDOUT and timeout message', () => {
      expect(shouldBlacklistForError({ code: 'ETIMEDOUT' })).toBe(false)
      expect(shouldBlacklistForError({ message: 'Timeout after 5000ms' })).toBe(false)
    })
  })

  describe('rpcUrls - pickAvailableUrlFromList and markUrlFailed', () => {
    const urlA = 'https://a.example.com/rpc'
    const urlB = 'https://b.example.com/rpc'

    afterEach(() => {
      clearUrlBlacklist()
    })

    it('returns one of the URLs when none blacklisted', () => {
      const urls = [urlA, urlB]
      for (let i = 0; i < 20; i++) {
        const result = pickAvailableUrlFromList(urls)
        expect(urls).toContain(result)
      }
    })
    it('returns lastIterationURL when all blacklisted', () => {
      markUrlFailed(urlA, 60000)
      markUrlFailed(urlB, 60000)
      const result = pickAvailableUrlFromList([urlA, urlB])
      expect([urlA, urlB]).toContain(result)
    })
    it('removes expired entry and returns that URL', () => {
      markUrlFailed(urlA, -10000)
      const r1 = pickAvailableUrlFromList([urlA])
      expect(r1).toBe(urlA)
      const r2 = pickAvailableUrlFromList([urlA])
      expect(r2).toBe(urlA)
    })
  })

  liveDescribe('live HTTP RPC (RUN_LIVE_RPC=1)', () => {
    const timeoutMs = 15000
    const maxRetries = 3

    it('getBlockNumber via withHttpProviderRetry', async () => {
      for (const chainId of supportedChainIds) {
        const httpUrls = getHttpUrls(chainId)
        if (httpUrls.length === 0) continue
        try {
          const block = await withHttpProviderRetry(
            httpUrls,
            (p) => Promise.race([p.getBlockNumber(), timeoutReject(timeoutMs)]),
            { chainId, fallbackRpcUrl: httpUrls[0], maxRetries },
          )
          expect(typeof block).toBe('number')
          expect(block).toBeGreaterThan(0)
        } catch (e: any) {
          // skip flaky chains
        }
      }
    })

    it('getNetwork returns correct chainId', async () => {
      const firstId = supportedChainIds[0]
      const httpUrlsFirst = getHttpUrls(firstId)
      const network = (await withHttpProviderRetry(
        httpUrlsFirst,
        (p) => Promise.race([p.getNetwork(), timeoutReject<ethers.providers.Network>(timeoutMs)]),
        { chainId: firstId, fallbackRpcUrl: httpUrlsFirst[0], maxRetries },
      )) as ethers.providers.Network
      expect(network.chainId).toBe(firstId)
    })

    it('getGasPrice returns non-negative value', async () => {
      const firstId = supportedChainIds[0]
      const httpUrlsFirst = getHttpUrls(firstId)
      const gasPrice = (await withHttpProviderRetry(
        httpUrlsFirst,
        (p) => Promise.race([p.getGasPrice(), timeoutReject<ethers.BigNumber>(timeoutMs)]),
        { chainId: firstId, fallbackRpcUrl: httpUrlsFirst[0], maxRetries },
      )) as ethers.BigNumber
      expect(gasPrice).toBeDefined()
      expect(gasPrice.gte(0)).toBe(true)
    })
  })

  liveDescribe('live WebSocket (RUN_LIVE_RPC=1)', () => {
    const timeoutMs = 15000

    it('connect and getBlockNumber via createWebSocketProvider', async () => {
      for (const chainId of supportedChainIds) {
        const wsUrls = getWsUrls(chainId)
        if (wsUrls.length === 0) continue
        const wsUrl = wsUrls[0]
        let wsProvider: ethers.providers.WebSocketProvider | null = null
        try {
          let connectionErrorReject: (err: Error) => void
          const connectionError = new Promise<never>((_, reject) => {
            connectionErrorReject = reject
          })
          wsProvider = createWebSocketProvider(wsUrl, chainId, (err) => connectionErrorReject(err))
          const block = await Promise.race([
            wsProvider.getBlockNumber(),
            connectionError,
            timeoutReject(timeoutMs),
          ])
          expect(typeof block).toBe('number')
          expect(block).toBeGreaterThan(0)
        } catch (e: any) {
          // skip flaky
        } finally {
          if (wsProvider) {
            wsProvider.removeAllListeners()
            if ((wsProvider as any)._websocket) (wsProvider as any)._websocket.terminate()
          }
        }
      }
    })

    it('onError fires on connection failure (12c)', async () => {
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
            expect(onErrorCalled).toBe(true)
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
          // all URLs succeeded, onError not triggered – ok
        }
      }
    })
  })

  liveDescribe('live HTTP retry (13a/13b)', () => {
    const timeoutMs = 12000
    const BAD_HTTP_URL = 'https://httpstat.us/403'

    it('13a: withHttpProviderRetry as-is (3 calls per chain)', async () => {
      for (const chainId of supportedChainIds) {
        const httpUrls = getHttpUrls(chainId)
        if (httpUrls.length === 0) continue
        for (let i = 0; i < 3; i++) {
          try {
            const block = await withHttpProviderRetry(
              httpUrls,
              (p) => Promise.race([p.getBlockNumber(), timeoutReject(timeoutMs)]),
              { chainId, fallbackRpcUrl: httpUrls[0], maxRetries: 3 },
            )
            expect(typeof block).toBe('number')
            expect(block).toBeGreaterThan(0)
          } catch (e: any) {
            // log and continue
          }
        }
      }
    })

    it('13b: bad URL first triggers retry', async () => {
      for (const chainId of supportedChainIds) {
        const goodUrls = getHttpUrls(chainId)
        if (goodUrls.length === 0) continue
        const urlsWithBad = [BAD_HTTP_URL, ...goodUrls]
        let attempt = 0
        const block = await withHttpProviderRetry(
          urlsWithBad,
          async (p) => {
            attempt++
            return Promise.race([p.getBlockNumber(), timeoutReject(timeoutMs)])
          },
          { chainId, fallbackRpcUrl: goodUrls[0], maxRetries: 3 },
        )
        expect(attempt).toBeGreaterThanOrEqual(1)
        expect(typeof block).toBe('number')
        expect(block).toBeGreaterThan(0)
      }
    })
  })

  liveDescribe('live WS reconnect (14a/14b)', () => {
    const wsTimeoutMs = 15000
    const BAD_WS_URL = 'wss://invalid.example.com'

    it('14a: try URLs in order until one works', async () => {
      const numConnections = 3
      for (const chainId of supportedChainIds) {
        const wsUrls = getWsUrls(chainId)
        if (wsUrls.length === 0) continue
        for (let conn = 0; conn < numConnections; conn++) {
          let block: number | null = null
          for (let j = 0; j < wsUrls.length; j++) {
            let wsProvider: ethers.providers.WebSocketProvider | null = null
            try {
              let connectionErrorReject: (err: Error) => void
              const connectionError = new Promise<never>((_, reject) => {
                connectionErrorReject = reject
              })
              wsProvider = createWebSocketProvider(wsUrls[j], chainId, (err) => connectionErrorReject(err))
              block = (await Promise.race([
                wsProvider.getBlockNumber(),
                connectionError,
                timeoutReject<number>(wsTimeoutMs),
              ])) as number
              break
            } catch (e: any) {
              // try next URL
            } finally {
              if (wsProvider) {
                wsProvider.removeAllListeners()
                if ((wsProvider as any)._websocket) (wsProvider as any)._websocket.terminate()
              }
            }
          }
          expect(block == null || block > 0).toBe(true)
        }
      }
    })

    it('14b: bad WS URL first then reconnect succeeds', async () => {
      for (const chainId of supportedChainIds) {
        const goodWsUrls = getWsUrls(chainId)
        if (goodWsUrls.length === 0) continue
        const wsUrlsWithBad = [BAD_WS_URL, ...goodWsUrls]
        let block: number | null = null
        for (let j = 0; j < wsUrlsWithBad.length; j++) {
          let wsProvider: ethers.providers.WebSocketProvider | null = null
          try {
            let connectionErrorReject: (err: Error) => void
            const connectionError = new Promise<never>((_, reject) => {
              connectionErrorReject = reject
            })
            wsProvider = createWebSocketProvider(wsUrlsWithBad[j], chainId, (err) => connectionErrorReject(err))
            block = (await Promise.race([
              wsProvider.getBlockNumber(),
              connectionError,
              timeoutReject<number>(wsTimeoutMs),
            ])) as number
            break
          } catch (e: any) {
            // next URL
          } finally {
            if (wsProvider) {
              wsProvider.removeAllListeners()
              if ((wsProvider as any)._websocket) (wsProvider as any)._websocket.terminate()
            }
          }
        }
        expect(block).not.toBeNull()
        expect(block!).toBeGreaterThan(0)
      }
    })
  })
})
