import 'dotenv/config'
import {ethers} from 'ethers'
import * as fs from 'fs'
import {writeFile} from 'fs/promises'
import * as path from 'path'
import axios, {AxiosResponse} from 'axios'
import http from 'http'
import https from 'https'
import * as crypto from '@shardus/crypto-utils'
import {
  ChainConfig,
  ChainConfigs,
  chainConfigsRaw,
  getConfiguredChains,
  getEffectiveChainIds,
  getChainConfigById,
  toNetworkChainId,
  ParamsConfig,
  paramsConfigRaw,
} from '../shared/config'
import {resolveProjectRoot} from '../shared/utils/paths'
import {startDriftResistantScheduler} from '../shared/utils/scheduler'
import {toEthereumAddress, toShardusAddress} from '../shared/utils/transformAddress'
import {isNormalizedTxId, normalizeTxId} from '../shared/utils/transformTxId'
import {deriveDeterministicChannelId, deriveDeterministicChannelPassword, DEFAULT_SHARDUS_CRYPTO_HASH_KEY} from '../tss-tools/lib/channelId'
import {initializeChainRpcConfig} from '../shared/chainRpc'
import * as bnbTss from '../tss-tools/lib/bnbTss'
import {deriveObserverUrl, deriveTransactionsDbPath, resolveRuntimePartyIdx} from '../tss-tools/lib/tssPartyDefaults'
import * as TransactionDB from '../shared/storage/transactiondb'
import {Transaction, TransactionStatus, TransactionType, ExecutionHistoryEntry} from '../shared/storage/transactiondb'

const {BigNumber, utils: ethersUtils} = ethers

;(function enableTimestampedConsoleLogs() {
  const methods: Array<'log' | 'info' | 'warn' | 'error'> = ['log', 'info', 'warn', 'error']
  for (const method of methods) {
    const original = console[method].bind(console)
    console[method] = (...args: any[]) => {
      const ts = `[${new Date().toISOString()}]`
      const first = args[0]
      if (typeof first === 'string' && first.startsWith('\n')) {
        original(`\n${ts}`, first.slice(1), ...args.slice(1))
      } else {
        original(ts, ...args)
      }
    }
  }
})()

const {stringify, parse} = require(path.join(process.cwd(), 'external/stringify-shardus'))

interface ChainState {
  config: ChainConfig
  contract?: ethers.Contract
  // Bridge contract state (cooldown, max amount, last bridge-in time)
  bridgeInCooldown: number         // seconds
  maxBridgeInAmount: ethers.BigNumber
  lastBridgeInTime: number         // unix timestamp in seconds
  // Precomputed BigNumber values of gasConfig.gasPriceTiers (avoids parseUnits per-tx)
  gasPriceTiersBN: ethers.BigNumber[]
}

interface TransactionQueueItem {
  receipt: any
  from: string
  value: ethers.BigNumber | bigint
  txId: string
  type: 'tokenToCoin' | 'coinToToken' | 'vaultBridge'
  chainId: number // Add chainId to track which chain this transaction belongs to
  txTimestamp: number // Populated from source-chain timestamps and used for queue ordering
}

interface TxQueueEntry {
  txTimestamp: number // milliseconds, from source-chain event/block time
  status: 'pending' | 'processing' | 'completed' | 'incompleted' | 'failed' | 'reverted'
}

interface PartyInfo {
  idx: number
}


interface LiberdusTx {
  from: string
  to: string
  amount: bigint
  type: string
  // memo: string
  networkId: string
  chatId?: string
  timestamp?: number
  sign?: {
    owner: string
    sig: string
  }
}

interface SignedTx {
  [key: string]: any

  sign: {
    owner: string
    sig: string
  }
}

type ProcessOutcome = 'completed' | 'incompleted' | 'failed' | 'reverted' | 'skipped_db_completed' | 'skipped_db_failed' | 'skipped_db_reverted'

// Receipt is polled only while remaining cooldown time exceeds (bridgeInCooldown - this value).
// e.g. for a 60s cooldown: poll while remainingMs > 45s, skip receipt checks once < 45s remains —
// indicating another party likely already submitted and mined the tx.
const BRIDGE_COOLDOWN_RECEIPT_SKIP_TAIL_SEC = 15
const BRIDGE_COOLDOWN_DB_POLL_INTERVAL_MS = 3_000

function txStatusLabel(status: TransactionStatus): string {
  switch (status) {
    case TransactionStatus.PENDING:     return 'PENDING'
    case TransactionStatus.SUBMITTED:   return 'SUBMITTED'
    case TransactionStatus.COMPLETED:   return 'COMPLETED'
    case TransactionStatus.INCOMPLETED: return 'INCOMPLETED'
    case TransactionStatus.FAILED:      return 'FAILED'
    case TransactionStatus.REVERTED:    return 'REVERTED'
    default: return `UNKNOWN(${status})`
  }
}

const argv2 = process.argv[2]
const parsedIdx = argv2 != null && /^\d+$/.test(`${argv2}`.trim()) ? argv2 : undefined
const useDefaultSlotPath = parsedIdx == null || `${parsedIdx}`.trim() === ''
const operationFlag = parsedIdx == null ? argv2 : process.argv[3]

const verboseLogs = false

// Enable detailed logs for TSS signing flow (inputs, outputs, errors). Can be noisy, so toggle with care.
const PRINT_TSS_SIGN_LOGS = false

// ─── Chaos / Debug Flags ─────────────────────────────────────────────────────
// Inject failure scenarios during testing. All flags should be false for production.

/** Skip the pre-process/pre-sign local DB status guard in reconcileTxStatusWithLocalDB.
 *  Useful when testing without a populated DB or to force re-processing of already-completed txs. */
const DEBUG_SKIP_TX_STATUS_CHECK = false

/** Skip nonce drift reconciliation in reconcileNonceDrift; always returns toNonce-1 with no receiptId.
 *  Use when the DB nonce index is incomplete or to isolate signing flow from nonce logic. */
const DEBUG_SKIP_NONCE_RECONCILIATION = false

/** Force processVaultBridge to return 'incompleted' before submitting the EVM tx, simulating a
 *  mid-flight failure that leaves a gap in the on-chain nonce sequence (chaos: nonce drift test). */
const DEBUG_SIMULATE_NONCE_DRIFT = false

// ─────────────────────────────────────────────────────────────────────────────

const serverStartTime = Date.now()

const params: ParamsConfig = paramsConfigRaw
const chainConfigs: ChainConfigs = chainConfigsRaw

let t = params.threshold
let n = params.parties

const TSS_SIGN_DISCOVERY_TIMEOUT_MS = 60 * 1000
const TSS_SIGN_DISCOVERY_TIMEOUT = `${TSS_SIGN_DISCOVERY_TIMEOUT_MS / 1000}s`
const TSS_SIGN_PROCESS_TIMEOUT_MS = TSS_SIGN_DISCOVERY_TIMEOUT_MS + 30 * 1000
const TX_PROCESSING_TIMEOUT_ERROR = 'tx-processing-timeout'
const LIBERDUS_TIMESTAMP_MIN_FUTURE_MS = TSS_SIGN_PROCESS_TIMEOUT_MS + 15 * 1000 // 15s higher than TSS_SIGN_PROCESS_TIMEOUT_MS

// Unified BridgedOut event ABI (all contracts use this 5-param signature)
// Shared bridge contract ABI for state reads and bridgeIn
const BRIDGE_CONTRACT_ABI = [
  'function bridgeInCooldown() view returns (uint256)',
  'function maxBridgeInAmount() view returns (uint256)',
  'function lastBridgeInTime() view returns (uint256)',
  'function bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId) public',
  'event BridgedIn(address indexed to, uint256 amount, uint256 indexed chainId, bytes32 indexed txId, uint256 timestamp)',
]
const BRIDGE_CONTRACT_IFACE = new ethersUtils.Interface(BRIDGE_CONTRACT_ABI)


const collectorHost = process.env.COLLECTOR_HOST || chainConfigs.collectorHost;
const proxyServerHost = process.env.PROXY_SERVER_HOST || chainConfigs.proxyServerHost;

// Calls the V8 garbage collector only when --expose-gc is active.
// Without that flag global.gc is undefined and calls would silently no-op.
let gcUnavailableWarned = false
function tryGC(): void {
  if (typeof global.gc === 'function') {
    global.gc()
  } else if (!gcUnavailableWarned) {
    gcUnavailableWarned = true
    console.warn('[gc] global.gc is not available — start Node with --expose-gc to enable forced GC')
  }
}

// Observer URL and DB path — derived from party index (set after ourParty is initialized below)

const ourParty: PartyInfo = {idx: resolveRuntimePartyIdx(parsedIdx)}

const observerUrl = deriveObserverUrl(ourParty.idx)
const dbPath = deriveTransactionsDbPath(process.cwd(), ourParty.idx)

// In vault mode use [vaultChain, secondaryChainConfig]; in Liberdus mode use supportedChains
const chainsToInit: ChainConfig[] = getConfiguredChains(chainConfigs)
const chainRpcConfig = initializeChainRpcConfig(chainsToInit)
// Give eth_sendRawTransaction a slightly longer budget than reads on public testnet RPCs.
const TSS_PARTY_SEND_TX_TIMEOUT_MS = 15_000

const chainStateByChainId: Map<number, ChainState> = new Map(
  chainsToInit.map((config) => [
    config.chainId,
    {
      config,
      bridgeInCooldown: 0,
      maxBridgeInAmount: ethers.BigNumber.from(0),
      lastBridgeInTime: 0,
      gasPriceTiersBN: (config.gasConfig?.gasPriceTiers ?? []).map((t) =>
        ethersUtils.parseUnits(t.toString(), 'gwei'),
      ),
    },
  ]),
)

for (const [chainId, chainState] of chainStateByChainId) {
  console.log(`Initialized chain state for ${chainState.config.name} (chainId ${chainId}) with bridge contract at ${chainState.config.contractAddress}`)
}

type FetchBridgeStateFields = 'all' | 'bridgeInCooldown' | 'maxBridgeInAmount' | 'lastBridgeInTime'

// Fetch bridge contract state for a chain. Pass fields to limit which values are fetched.
async function fetchBridgeState(
  chainId: number,
  fields: FetchBridgeStateFields = 'all',
): Promise<void> {
  const chainState = chainStateByChainId.get(chainId)
  if (!chainState) return

  const contractAddr = chainState.config.contractAddress
  try {
    if (fields === 'all') {
      const [cooldownRaw, maxAmountRaw, lastTimeRaw] = await Promise.all([
        chainRpcConfig.withChainHttpProvider(chainId, (provider) =>
          provider.call({to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('bridgeInCooldown')}),
          { maxRetries: 3 },
        ),
        chainRpcConfig.withChainHttpProvider(chainId, (provider) =>
          provider.call({to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('maxBridgeInAmount')}),
          { maxRetries: 3 },
        ),
        chainRpcConfig.withChainHttpProvider(chainId, (provider) =>
          provider.call({to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('lastBridgeInTime')}),
          { maxRetries: 3 },
        ),
      ])
      chainState.bridgeInCooldown = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('bridgeInCooldown', cooldownRaw)[0].toNumber()
      chainState.maxBridgeInAmount = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('maxBridgeInAmount', maxAmountRaw)[0]
      chainState.lastBridgeInTime = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('lastBridgeInTime', lastTimeRaw)[0].toNumber()
      const lastBridgeInStr = chainState.lastBridgeInTime > 0
        ? new Date(chainState.lastBridgeInTime * 1000).toISOString()
        : 'never'
      const maxAmountStr = `${ethersUtils.formatEther(chainState.maxBridgeInAmount)} ETH`
      console.log(
        `Bridge state fetched for ${chainState.config.name}: ` +
        `cooldown=${chainState.bridgeInCooldown}s, ` +
        `maxBridgeInAmount=${maxAmountStr}, ` +
        `lastBridgeInTime=${lastBridgeInStr}`
      )
    } else if (fields === 'lastBridgeInTime') {
      const lastTimeRaw = await chainRpcConfig.withChainHttpProvider(chainId, (provider) =>
        provider.call({to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('lastBridgeInTime')}),
        { maxRetries: 3 },
      )
      chainState.lastBridgeInTime = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('lastBridgeInTime', lastTimeRaw)[0].toNumber()
      const lastBridgeInStr = chainState.lastBridgeInTime > 0
        ? new Date(chainState.lastBridgeInTime * 1000).toISOString()
        : 'never'
      console.log(`Bridge lastBridgeInTime fetched for ${chainState.config.name}: ${lastBridgeInStr}`)
    } else if (fields === 'bridgeInCooldown') {
      const cooldownRaw = await chainRpcConfig.withChainHttpProvider(chainId, (provider) =>
        provider.call({to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('bridgeInCooldown')}),
        { maxRetries: 3 },
      )
      chainState.bridgeInCooldown = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('bridgeInCooldown', cooldownRaw)[0].toNumber()
      console.log(`Bridge bridgeInCooldown fetched for ${chainState.config.name}: ${chainState.bridgeInCooldown}s`)
    } else if (fields === 'maxBridgeInAmount') {
      const maxAmountRaw = await chainRpcConfig.withChainHttpProvider(chainId, (provider) =>
        provider.call({to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('maxBridgeInAmount')}),
        { maxRetries: 3 },
      )
      chainState.maxBridgeInAmount = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('maxBridgeInAmount', maxAmountRaw)[0]
      const maxAmountStr = `${ethersUtils.formatEther(chainState.maxBridgeInAmount)} ETH`
      console.log(`Bridge maxBridgeInAmount fetched for ${chainState.config.name}: ${maxAmountStr}`)
    }
  } catch (error) {
    console.warn(`Failed to fetch bridge state for chain ${chainId}:`, error)
    throw error
  }
}

async function waitForBridgeCooldown(
  chainState: ChainState,
  chainName: string,
  txId: string,
  txHash: string,
): Promise<{ receipt: ethers.providers.TransactionReceipt | null; outcome: ProcessOutcome | null }> {
  const latestBlock = await chainRpcConfig.withChainHttpProvider(
    chainState.config.chainId,
    (provider) => provider.getBlock('latest'),
    { maxRetries: 3 },
  )
  const now = latestBlock.timestamp
  const cooldownEnd = chainState.lastBridgeInTime + chainState.bridgeInCooldown
  const waitSec = Math.max(0, cooldownEnd - now)
  const receiptCheckMinRemainingSec = Math.max(
    0,
    chainState.bridgeInCooldown - BRIDGE_COOLDOWN_RECEIPT_SKIP_TAIL_SEC,
  )

  console.log(
    `Bridge-in cooldown check on ${chainName}: ` +
    `wait=${waitSec}s, ` +
    `lastBridgeInTime=${new Date(chainState.lastBridgeInTime * 1000).toISOString()}, ` +
    `cooldown=${chainState.bridgeInCooldown}s, ` +
    `cooldownEnd=${new Date(cooldownEnd * 1000).toISOString()}, ` +
    `chainNow=${new Date(now * 1000).toISOString()}, ` +
    `receiptCheckMinRemaining=${receiptCheckMinRemainingSec}s`
  )

  if (waitSec > 0) {
    const waitDeadlineMs = Date.now() + waitSec * 1000
    while (true) {
      const remainingMs = waitDeadlineMs - Date.now()
      if (remainingMs <= 0) break

      const dbStatus = reconcileTxStatusWithLocalDB(txId, 'pre-submit')
      if (dbStatus != null) {
        return { receipt: null, outcome: dbStatusToSkipOutcome(dbStatus) }
      }

      // Poll while remaining cooldown time exceeds the threshold — another party may have already
      // submitted and mined the same deterministic tx, so checking its receipt lets us short-circuit.
      if (remainingMs > receiptCheckMinRemainingSec * 1000) {
        try {
          const receipt = await getChainTransactionReceipt(chainState.config.chainId, txHash)
          if (receipt) {
            console.log(`[cooldown] Found receipt on ${chainName} for ${txHash}: status=${receipt.status} block=${receipt.blockNumber}`)
            return { receipt, outcome: null }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          console.warn(`[cooldown] Failed to fetch receipt on ${chainName} for ${txHash}: ${reason}`)
        }
      }

      await sleep(Math.min(remainingMs, BRIDGE_COOLDOWN_DB_POLL_INTERVAL_MS))
    }
  }

  return { receipt: null, outcome: null }
}

async function checkMaxBridgeAmount(
  chainState: ChainState,
  value: ethers.BigNumber,
  skipRefetch = false,
): Promise<boolean> {
  if (value.lte(chainState.maxBridgeInAmount)) return true
  if (skipRefetch) return false
  // Cached check failed — re-fetch in case the limit was raised on-chain
  console.log(`[bridge-limits] Cached maxBridgeInAmount check failed, re-fetching for chain ${chainState.config.chainId}`)
  await fetchBridgeState(chainState.config.chainId, 'maxBridgeInAmount')
  return value.lte(chainState.maxBridgeInAmount)
}


async function refreshBridgeStateOnFailed(reason: string | undefined, chainId: number): Promise<void> {
  if (!reason || (!reason.includes('Bridge-in cooldown not met') && !reason.includes('Amount exceeds bridge-in limit'))) return
  console.log(`Refreshing bridge state for chain ${chainId} due to on-chain failure: ${reason}`)
  try {
    await fetchBridgeState(chainId)
  } catch (error) {
    console.warn(`[bridge-state] Failed to refresh state after on-chain failure on chain ${chainId}:`, error)
  }
}

async function fetchStartupBridgeState(): Promise<void> {
  for (const [chainId] of chainStateByChainId.entries()) {
    if (!chainConfigs.enableLiberdusNetwork && chainId === chainConfigs.vaultChain!.chainId) continue
    console.log(`Fetching bridge state for chain ${chainId}`)
    await fetchBridgeState(chainId)
  }
}

async function logStartupSignerBalances(): Promise<void> {
  for (const chainId of getEffectiveChainIds(chainConfigs)) {
    const config = getChainConfigById(chainConfigs, chainId)
    if (!config?.tssSenderAddress) continue
    try {
      const signerBalance = await chainRpcConfig.withChainHttpProvider(
        chainId,
        (provider) => provider.getBalance(config.tssSenderAddress!),
        { maxRetries: 3 },
      )
      console.log(
        `Signer ${config.tssSenderAddress} balance on ${config.name}: ${ethersUtils.formatEther(signerBalance)} ETH`,
      )
    } catch (error) {
      console.warn(`[startup] Failed to fetch signer balance for ${config.name} (${config.tssSenderAddress}):`, error)
    }
  }
}

const cryptoInitKey = process.env.SHARDUS_CRYPTO_HASH_KEY || DEFAULT_SHARDUS_CRYPTO_HASH_KEY
crypto.init(cryptoInitKey)
crypto.setCustomStringifier(stringify, 'shardus_safeStringify')

const KEYSTORE_DIR = path.join(resolveProjectRoot(), 'keystores')

if (!fs.existsSync(KEYSTORE_DIR)) {
  fs.mkdirSync(KEYSTORE_DIR, {recursive: true})
}

const pendingTxQueue: TransactionQueueItem[] = []
const txQueueMap: Map<string, TxQueueEntry> = new Map()
// Deferred removal set — populated wherever a tx should be dropped from
// pendingTxQueue. Drained at the top of each handleTransactionQueue tick so
// that no async code mutates pendingTxQueue while the dispatch loop iterates it.
const pendingTxQueueRemovalSet = new Set<string>()
const txQueueProcessingInterval = 10000
const TX_POLL_INTERVAL = 10 * 1000 // 10s
const TX_PROCESSING_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes total, covering the 1.5-minute signing timeout and the 1-minute bridge-in cooldown within the same window

const TX_CLEANUP_MAX_AGE = 60 * 60 * 1000 // 1 hour for all statuses


// Define maximum concurrent transactions
const MAX_CONCURRENT_TXS = 1
const processingTransactionIds = new Map<string, TransactionQueueItem>()

const delay_ms = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Global HTTP agents with keep-alive enabled.
// keepAlive:      reuse sockets across requests and lets the OS send TCP probes
//                 on idle connections to avoid reconnect churn under steady polling.
// keepAliveMsecs: initial delay before the OS starts probing (30 s is standard).
// maxSockets:     cap concurrent connections per host; TSS party traffic is low,
//                 so 10 is ample.
// maxFreeSockets: idle socket pool size per host — small pool is enough here.
const httpAgent  = new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 10, maxFreeSockets: 5 })
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 10, maxFreeSockets: 5 })
axios.defaults.httpAgent  = httpAgent
axios.defaults.httpsAgent = httpsAgent

// Add this cleanup function for memory management
function cleanupOldTransactions() {
  const now = Date.now()
  let removedCount = 0
  const removedTxIds = new Set<string>()

  for (const [txId, entry] of txQueueMap.entries()) {
    if (entry.status === 'pending' || entry.status === 'processing') continue
    const txAge = entry.txTimestamp > 0 ? now - entry.txTimestamp : now - serverStartTime
    if (txAge > TX_CLEANUP_MAX_AGE) {
      txQueueMap.delete(txId)
      processingTransactionIds.delete(txId)
      removedTxIds.add(txId)
      removedCount++
      console.log(`🗑️ Removed ${entry.status} transaction ${txId} (age: ${Math.round(txAge / 60000)}min)`)
    }
  }

  if (removedTxIds.size > 0) {
    const before = pendingTxQueue.length
    for (const tx of pendingTxQueue) {
      if (removedTxIds.has(tx.txId)) {
        appendToFailedTxsLogs(tx, 'removed from pending queue during cleanup due to max age')
      }
    }
    const kept = pendingTxQueue.filter((tx) => !removedTxIds.has(tx.txId))
    pendingTxQueue.splice(0, pendingTxQueue.length, ...kept)
    const pruned = before - pendingTxQueue.length
    if (pruned > 0) {
      console.log(`🧹 Pruned ${pruned} stale transactions from pendingTxQueue`)
    }
  }

  // Prune stale signedTxCache entries (FAILED txs that were never retried)
  let cacheEvicted = 0
  for (const [txId, entry] of signedTxCache.entries()) {
    if (now - entry.cachedAt > TX_CLEANUP_MAX_AGE) {
      signedTxCache.delete(txId)
      cacheEvicted++
    }
  }
  if (cacheEvicted > 0) {
    console.log(`🧹 Evicted ${cacheEvicted} stale signedTxCache entries`)
  }

  const statusCounts = {
    pending: pendingTxQueue.length,
    processing: processingTransactionIds.size,
    done: txQueueMap.size - pendingTxQueue.length - processingTransactionIds.size,
  }
  console.log(`🧹 Cleanup complete. Removed ${removedCount} transactions. Counts:`, statusCounts)
  console.log(`📊 txQueueMap size: ${txQueueMap.size}, pendingTxQueue: ${pendingTxQueue.length}, processing: ${processingTransactionIds.size}`)

  // Force garbage collection more aggressively
  if (global.gc && (removedCount > 0 || process.memoryUsage().heapUsed > 256 * 1024 * 1024)) { // 256MB threshold
    const beforeGC = process.memoryUsage().heapUsed
    tryGC()
    const afterGC = process.memoryUsage().heapUsed
    const freedMB = Math.round((beforeGC - afterGC) / 1024 / 1024)
    if (freedMB > 0) {
      console.log(`🗑️ Forced garbage collection freed ${freedMB} MB`)
    }
  }
}

function appendToFailedTxsLogs(txData: TransactionQueueItem, error: string): void {
  try {
    const filePath = path.join(KEYSTORE_DIR, `failed_txs_logs_party_${ourParty.idx}.ndjson`)
    const line = JSON.stringify({
      txId: txData.txId,
      from: txData.from,
      value: txData.value.toString(),
      type: txData.type,
      chainId: txData.chainId,
      txTimestamp: txData.txTimestamp,
      failedAt: Date.now(),
      error,
    }) + '\n'
    fs.appendFileSync(filePath, line)
  } catch (err) {
    console.error('[failedTxsLogs] Failed to append failed tx:', err)
  }
}


// Display all EOA addresses for a party across all chains
function verifyEthereumTx(obj: SignedTx): boolean {
  if (typeof obj !== 'object') throw new TypeError('Input must be an object.')
  if (!obj.sign || !obj.sign.owner || !obj.sign.sig)
    throw new Error('Object must contain a sign field with the following data: { owner, sig }')
  if (typeof obj.sign.owner !== 'string')
    throw new TypeError('Owner must be a public key represented as a hex string.')
  if (typeof obj.sign.sig !== 'string')
    throw new TypeError('Signature must be a valid signature represented as a hex string.')
  const {owner, sig} = obj.sign
  const dataWithoutSign = {...obj}
  ;(dataWithoutSign as any).sign = undefined
  const message = crypto.hashObj(dataWithoutSign)
  const recoveredAddress = ethersUtils.verifyMessage(message, sig)
  const recoveredShardusAddress = toShardusAddress(recoveredAddress)
  const isValid = recoveredShardusAddress.toLowerCase() === owner.toLowerCase()
  console.log('Signed Obj', obj)
  console.log('Signature verification result:')
  console.log('Is Valid:', isValid)
  console.log('message', message)
  console.log('Owner Address:', obj.sign.owner)
  console.log('Recovered Address:', recoveredAddress)
  console.log('Recovered Shardus Address:', recoveredShardusAddress)
  return isValid
}

function getAxiosErrorMessage(error: unknown): string {
  return axios.isAxiosError(error)
    ? (error.cause instanceof Error ? error.cause.message : error.message)
    : (error instanceof Error ? error.message : String(error))
}

function updateTxStatusInLocalDB(
  txId: string,
  status: TransactionStatus,
  receiptId: string,
  tssSender: string,
  nonce: number,
  failedReason = '',
): ReturnType<typeof TransactionDB.updateTransactionStatus> {
  try {
    const normalizedTxId = normalizeTxId(txId)
    const normalizedReceiptId = receiptId ? normalizeTxId(receiptId) : receiptId

    const normalizedTssSender = toEthereumAddress(tssSender)

    const result = TransactionDB.updateTransactionStatus(
      normalizedTxId,
      status,
      normalizedReceiptId,
      normalizedTssSender,
      nonce,
      failedReason || null,
    )

    if (result === 'ok') {
      console.log(`[updateTxStatus] Updated ${normalizedTxId} → status=${status}`)
    } else if (result === 'duplicate') {
      console.log(`[updateTxStatus] Duplicate status update ignored for ${normalizedTxId}`)
    } else if (result === 'no_downgrade') {
      console.log(`[updateTxStatus] Status downgrade blocked for ${normalizedTxId} (attempted ${status})`)
    } else if (result === 'not_found') {
      console.error(`[updateTxStatus] Transaction ${normalizedTxId} not found in local DB`)
    }
    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[updateTxStatus] Error updating status for ${txId}: ${errorMessage}`)
    return 'not_found'
  }
}


async function pollPendingTransactionsFromLocalDB(): Promise<void> {
  if (verboseLogs) console.log('Polling pending transactions from local DB...', new Date().toISOString())
  try {
    const dbTxs = TransactionDB.getTransactionsByPage(10, 0, { unprocessed: true })
    const transactions: Transaction[] = dbTxs
      .slice()
      .sort((a, b) => a.txTimestamp - b.txTimestamp)
    if (transactions.length === 0) return

    console.log(`[poll] Found ${transactions.length} unprocessed transactions`)

    let txAddedToQueue = false
    for (const tx of transactions) {
      if (!tx.txId || !isNormalizedTxId(tx.txId)) {
        console.warn(`[poll] Skipping tx with invalid txId (expected 64 chars): ${tx.txId}`)
        continue
      }
      if (!tx.txTimestamp || !tx.sender || !tx.value || tx.chainId == null) {
        console.warn(`[poll] Skipping tx ${tx.txId} — missing required fields (txTimestamp/sender/value/chainId)`, tx)
        continue
      }
      if (!getChainConfigById(chainConfigs, tx.chainId)) {
        console.warn(`[poll] Skipping tx ${tx.txId} — unknown chainId ${tx.chainId}`)
        continue
      }
      if (tx.status === TransactionStatus.COMPLETED || tx.status === TransactionStatus.FAILED) {
        console.log(`[poll] Skipping tx ${tx.txId} — DB reports ${txStatusLabel(tx.status)}`)
        continue
      }

      const existingEntry = txQueueMap.get(tx.txId)
      if (existingEntry) {
        // If we previously marked it incompleted/failed locally but the DB still
        // reports it as unprocessed, queue it again.
        if ((existingEntry.status === 'incompleted' || existingEntry.status === 'failed') && !pendingTxQueue.some(t => t.txId === tx.txId)) {
          console.log(`[poll] Retrying tx ${tx.txId} — previously ${existingEntry.status} locally but DB reports ${txStatusLabel(tx.status)}`)
          // fall through to re-queue below
        } else {
          continue
        }
      }


      const bridgeType: TransactionQueueItem['type'] =
        tx.type === TransactionType.BRIDGE_IN
          ? 'coinToToken'
          : tx.type === TransactionType.BRIDGE_VAULT
            ? 'vaultBridge'
            : 'tokenToCoin'

      const value = ethers.BigNumber.from(tx.value)

      const txData: TransactionQueueItem = {
        receipt: null as any,
        from: tx.sender,
        value,
        txId: tx.txId,
        type: bridgeType,
        chainId: tx.chainId,
        txTimestamp: tx.txTimestamp,
      }

      pendingTxQueue.push(txData)
      if (existingEntry) {
        if (existingEntry.status === 'incompleted' || existingEntry.status === 'failed') {
          existingEntry.status = 'pending'
        }
      } else {
        txQueueMap.set(tx.txId, { txTimestamp: tx.txTimestamp, status: 'pending' })
      }
      const chainName = getChainConfigById(chainConfigs, tx.chainId)?.name || 'Unknown'
      console.log(`[poll] ${existingEntry ? 'Re-queued' : 'Added'} ${bridgeType} tx ${tx.txId} from local DB (${chainName})`)
      txAddedToQueue = true
    }

    if (txAddedToQueue) {
      pendingTxQueue.sort((a, b) => {
        return a.txTimestamp - b.txTimestamp
      })
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[poll] Error polling pending transactions from local DB: ${errorMessage}`)
  }
}


function checkTxStatusFromLocalDB(txId: string): TransactionStatus | null {
  try {
    const normalizedTxId = normalizeTxId(txId)
    const tx = TransactionDB.getTransactionById(normalizedTxId)
    if (!tx) return null
    return tx.status
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`[checkTxStatus] DB read failed for ${txId}: ${errorMessage}`)
  }
}

// ---------------------------------------------------------------------------
// Nonce manager — tracks the expected next EVM nonce per chain per sender.
// Initialized from on-chain state at startup, incremented locally on
// success/on-chain failure (nonce consumed), NOT incremented on send failure.
// ---------------------------------------------------------------------------

const nonceManager: Map<string, number> = new Map() // key: `${chainId}:${tssSender}`

function nonceManagerKey(chainId: number, tssSender: string): string {
  return `${chainId}:${tssSender.toLowerCase()}`
}

async function initNonceManager(chainId: number, tssSender: string): Promise<void> {
  const chainNonce = await getLatestChainNonce(chainId, tssSender)
  const key = nonceManagerKey(chainId, tssSender)
  nonceManager.set(key, chainNonce)
  console.log(`[nonce-manager] Initialized ${key} -> nonce ${chainNonce}`)
}

function getLocalNonce(chainId: number, tssSender: string): number | undefined {
  return nonceManager.get(nonceManagerKey(chainId, tssSender))
}

function incrementLocalNonce(chainId: number, tssSender: string): void {
  const key = nonceManagerKey(chainId, tssSender)
  const current = nonceManager.get(key)
  if (current != null) {
    nonceManager.set(key, current + 1)
    console.log(`[nonce-manager] Incremented ${key} -> nonce ${current + 1}`)
  }
}

function setLocalNonce(chainId: number, tssSender: string, nonce: number): void {
  const key = nonceManagerKey(chainId, tssSender)
  nonceManager.set(key, nonce)
  console.log(`[nonce-manager] Set ${key} -> nonce ${nonce}`)
}

async function getLatestChainNonce(chainId: number, tssSender: string): Promise<number> {
  return chainRpcConfig.withChainHttpProvider(
    chainId, (provider) => provider.getTransactionCount(tssSender), { maxRetries: 3 })
}

async function getChainTransactionReceipt(chainId: number, txHash: string): Promise<ethers.providers.TransactionReceipt | null> {
  return chainRpcConfig.withChainHttpProvider(
    chainId, (provider) => provider.getTransactionReceipt(txHash), { maxRetries: 3 })
}

// Fetches gas price from a fixed RPC URL so all parties query the same endpoint,
// avoiding payload divergence from different Chainlist RPCs returning different values.
async function getGasPriceFromFixedRpc(rpcUrl: string, maxRetries = 3): Promise<ethers.BigNumber> {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.getGasPrice()
    } catch (err) {
      lastError = err
      if (attempt < maxRetries) {
        await new Promise((res) => setTimeout(res, 1000))
      }
    }
  }
  throw lastError
}

// ---------------------------------------------------------------------------
// In-memory signed tx cache — for EVM rebroadcast without re-signing.
// Keyed by normalized txId. Cleared on completion, on-chain failure, or process restart.
// ---------------------------------------------------------------------------

const signedTxCache: Map<string, { signedTx: string; txHash: string; nonce: number; cachedAt: number }> = new Map()

// ---------------------------------------------------------------------------
function reconcileTxStatusWithLocalDB(
  txId: string,
  context: 'pre-process' | 'pre-sign' | 'post-sign' | 'pre-submit',
): null | 'completed' | 'failed' | 'reverted' {
  if (DEBUG_SKIP_TX_STATUS_CHECK) return null
  try {
    const status = checkTxStatusFromLocalDB(txId)
    if (
      status == null ||
      status === TransactionStatus.PENDING ||
      status === TransactionStatus.SUBMITTED ||
      status === TransactionStatus.INCOMPLETED
    ) {
      return null
    }
    const statusLabel: 'completed' | 'failed' | 'reverted' =
      status === TransactionStatus.COMPLETED ? 'completed' :
      status === TransactionStatus.REVERTED  ? 'reverted' :
      'failed'
    console.log(`⏩ ${txId} already ${txStatusLabel(status)} in local DB (${context}), skipping`)
    return statusLabel
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.warn(`[${context}] Local DB status check failed for ${txId}, proceeding with tx: ${errorMessage}`)
    return null
  }
}

// Maps a reconcile skip status to the corresponding ProcessOutcome.
function dbStatusToSkipOutcome(
  status: 'completed' | 'failed' | 'reverted',
): ProcessOutcome {
  if (status === 'completed') return 'skipped_db_completed'
  if (status === 'reverted') return 'skipped_db_reverted'
  return 'skipped_db_failed'
}

// Syncs the local nonce to maxDbNonce+1 if any finalized (COMPLETED/FAILED/REVERTED) tx for this sender
// is ahead. chainId is the source chain as stored in the DB. For vaultBridge the nonce manager
// lives on the destination chain, so nonceCacheChainId is derived from txType.
// BRIDGE_OUT REVERTED records (refund bridgeIn calls) also consume an EVM nonce and are included.
function syncLocalNonceFromDB(txType: TransactionQueueItem['type'], chainId: number, tssSender: string): void {
  const normalizedTssSender = toEthereumAddress(tssSender)
  const dbTxType = txType === 'tokenToCoin' ? TransactionType.BRIDGE_OUT : undefined
  const maxDbNonce = TransactionDB.getMaxNonceForSender(chainId, normalizedTssSender, dbTxType)
  const nonceCacheChainId = txType === 'vaultBridge' ? chainConfigs.secondaryChainConfig!.chainId : chainId
  if (maxDbNonce == null) {
    console.log(
      `[nonce-manager] No finalized tx for sender=${tssSender} on chain=${nonceCacheChainId}, skipping nonce sync`
    )
    return
  }
  const currentLocal = getLocalNonce(nonceCacheChainId, tssSender)
  console.log(
    `[nonce-manager] Syncing local nonce for sender=${normalizedTssSender} ` +
    `on chain=${nonceCacheChainId} ` +
    `to nextNonce=${maxDbNonce + 1} from maxDbNonce=${maxDbNonce} ` +
    `(currentLocal=${currentLocal})`
  )
  if (currentLocal == null || maxDbNonce + 1 > currentLocal) {
    setLocalNonce(nonceCacheChainId, tssSender, maxDbNonce + 1)
    console.log(
      `[nonce-manager] Synced local nonce for sender=${normalizedTssSender} ` +
      `on chain=${nonceCacheChainId} ` +
      `to nextNonce=${maxDbNonce + 1}`
    )
  }
}


// reconcileNonceDrift — called when the chain nonce is ahead of the local nonce tracker.
// Checks the local DB for any tx in [fromNonce, toNonce) that matches currentTxId and is
// already COMPLETED (i.e. another party submitted and it succeeded while we were away).
// Gap nonces not in the DB are left for the observer to resolve asynchronously;
// the pre-sign reconcile guard catches FAILED/COMPLETED on the next retry.
// Returns receiptId if currentTxId was found COMPLETED in the DB, null otherwise.
// ---------------------------------------------------------------------------

function reconcileNonceDrift(
  currentTxId: string,
  chainId: number,
  tssSender: string,
  fromNonce: number,
  toNonce: number,
): { latestDbNonce: number; receiptId: string | null } {
  if (DEBUG_SKIP_NONCE_RECONCILIATION) return { latestDbNonce: toNonce - 1, receiptId: null }

  console.log(`[nonce-drift] Reconciling drift for chain=${chainId}: from=${fromNonce}, to=${toNonce}`)
  const normalizedTssSender = toEthereumAddress(tssSender)
  const driftTxs = TransactionDB.getTransactionsByNonceRange(chainId, normalizedTssSender, fromNonce, toNonce)
  console.log(`[nonce-drift] Found ${driftTxs.length} txs in drift range for chain=${chainId}`)

  let latestDbNonce = fromNonce - 1  // gap scan starts at latestDbNonce + 1 = fromNonce
  let receiptId = ''

  for (const tx of driftTxs) {
    // COMPLETED, FAILED, and BRIDGE_OUT REVERTED (refund bridgeIn) all consumed an on-chain nonce.
    // INCOMPLETED never reached the chain. BRIDGE_IN REVERTED stores a Liberdus timestamp, not an EVM nonce.
    const isNonceConsumed =
      tx.status === TransactionStatus.COMPLETED ||
      tx.status === TransactionStatus.FAILED ||
      (tx.status === TransactionStatus.REVERTED && tx.type === TransactionType.BRIDGE_OUT)
    if (isNonceConsumed && tx.receiptId && tx.txId === normalizeTxId(currentTxId)) {
      receiptId = tx.receiptId
    }
    if (isNonceConsumed && tx.nonce != null) {
      if (latestDbNonce < tx.nonce) {
        latestDbNonce = tx.nonce
      }
    }
    // Check execution history entries for additional consumed nonces
    const history: Record<string, ExecutionHistoryEntry> = JSON.parse(tx.executionHistory || '{}')
    for (const [nonceKey, entry] of Object.entries(history)) {
      if (entry.status === TransactionStatus.FAILED || entry.status === TransactionStatus.COMPLETED) {
        if (latestDbNonce < Number(nonceKey)) {
          latestDbNonce = Number(nonceKey)
        }
      }
    }
  }

  if (latestDbNonce + 1 < toNonce) {
    console.log(`[nonce-drift] Gap: DB only resolved up to nonce=${latestDbNonce}, chain is at ${toNonce} — observer will detect and resolve`)
  } else {
    console.log(`[nonce-drift] All drift nonces resolved in DB (latestDbNonce=${latestDbNonce})`)
  }

  return {
    latestDbNonce,
    receiptId: receiptId || null,
  }
}

function getBnbTssExpectedAddresses(): Record<number, string> {
  const expected: Record<number, string> = {}
  for (const chainId of getEffectiveChainIds(chainConfigs)) {
    const config = getChainConfigById(chainConfigs, chainId)!
    expected[chainId] = config.tssSenderAddress!
  }
  return expected
}

async function validateBnbTssSetup(): Promise<void> {
  const expectedAddressesByChainId = getBnbTssExpectedAddresses()
  const chainIds = Object.keys(expectedAddressesByChainId).map(Number)
  console.error('Validating BNB TSS vaults for chains', chainIds)
  if (chainIds.length === 0) {
    throw new Error('No chains configured for BNB TSS vault validation')
  }
  const results = bnbTss.validatePartyVaults({
    ...(useDefaultSlotPath ? {} : {partyIdx: ourParty.idx}),
    chainIds,
    expectedAddressesByChainId,
    useDefaultSlotPath,
  })
  console.log(`Validated BNB TSS vaults${useDefaultSlotPath ? '' : ` for party ${ourParty.idx}`}:`)
  for (const result of results) {
    console.log(
      `  chain ${result.chainId}: ${result.ethereum_address} (${result.home})`,
    )
  }
}

function signDigestWithBnbTss(chainId: number, digest: string, channelId: string, channelPassword: string) {
  console.log('Signing digest with BNB TSS', chainId, digest, channelId)
  return bnbTss.signDigest({
    ...(useDefaultSlotPath ? {} : {partyIdx: ourParty.idx}),
    chainId,
    useDefaultSlotPath,
    digest,
    channelId,
    channelPassword,
    signDiscoveryTimeout: TSS_SIGN_DISCOVERY_TIMEOUT,
    timeoutMs: TSS_SIGN_PROCESS_TIMEOUT_MS,
    printLogs: PRINT_TSS_SIGN_LOGS,
  })
}

async function signEthereumTransaction(
  tx: any,
  digest: string,
  chainId: number,
  channelId: string,
  channelPassword: string,
): Promise<string | null> {
  const startMemory = process.memoryUsage()
  let signature
  try {
    const signed = await signDigestWithBnbTss(chainId, digest, channelId, channelPassword)
    signature = {
      r: signed.r,
      s: signed.s,
      v: signed.v,
    }
  } catch (error) {
    if (error instanceof Error && error.message === bnbTss.SIGNING_TIMEOUT_ERROR) {
      throw error
    }
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`Failed to sign Ethereum transaction: ${errorMessage}`)
    return null
  }
  const address = ethersUtils.recoverAddress(digest, signature)
  const publicKey = ethersUtils.recoverPublicKey(digest, signature)
  const computeAddress = ethersUtils.computeAddress(publicKey)
  const signedTx = ethersUtils.serializeTransaction(tx, signature)
  
  // Monitor memory usage after signing
  const endMemory = process.memoryUsage()
  const memoryDelta = endMemory.heapUsed - startMemory.heapUsed
  if (memoryDelta > 5 * 1024 * 1024) { // Alert if > 5MB increase
    console.warn(`🚨 High memory increase during Ethereum signing: ${Math.round(memoryDelta / 1024 / 1024)} MB`)
  }
  
  console.log('Ethereum transaction signed successfully!', {
    ...tx,
    sign: {
      owner: computeAddress,
      sig: ethersUtils.joinSignature(signature),
    },
  })
  return signedTx
}

async function signLiberdusTransaction(
  tx: LiberdusTx,
  digest: string,
  chainId: number,
  channelId: string,
  channelPassword: string,
): Promise<SignedTx | null> {
  const startMemory = process.memoryUsage()
  let signature
  try {
    const signed = await signDigestWithBnbTss(chainId, digest, channelId, channelPassword)
    signature = {
      r: signed.r,
      s: signed.s,
      v: signed.v,
    }
  } catch (error) {
    if (error instanceof Error && error.message === bnbTss.SIGNING_TIMEOUT_ERROR) {
      throw error
    }
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`Failed to sign Liberdus transaction: ${errorMessage}`)
    return null
  }
  const serializedSignature = ethersUtils.joinSignature(signature)
  const signedTx: SignedTx = {
    ...tx,
    sign: {
      owner: tx.from,
      sig: serializedSignature,
    },
  }
  const isValid = verifyEthereumTx(signedTx)
  if (!isValid) {
    return null
  }
  
  // Monitor memory usage after signing
  const endMemory = process.memoryUsage()
  const memoryDelta = endMemory.heapUsed - startMemory.heapUsed
  if (memoryDelta > 5 * 1024 * 1024) { // Alert if > 5MB increase
    console.warn(`🚨 High memory increase during Liberdus signing: ${Math.round(memoryDelta / 1024 / 1024)} MB`)
  }
  
  console.log('Liberdus transaction signed successfully!', signedTx)
  return signedTx
}

async function injectEthereumTx(
  chainId: number,
  txHash: string,
  signedTx: string,
): Promise<{ success: boolean; reason?: string }> {
  try {
    const txResponse = await chainRpcConfig.withChainHttpProvider(
      chainId,
      (provider) => provider.sendTransaction(signedTx),
      { maxRetries: 1, timeoutMs: TSS_PARTY_SEND_TX_TIMEOUT_MS },
    )
    console.log('BridgeIn transaction sent successfully!', txResponse.hash)
  } catch (e: any) {
    console.log('Error sending ethereum transaction:', txHash, e.message)
    throw e
  }
  return {success: true}
}

async function injectLiberdusTx(
  txId: string,
  signedTx: SignedTx,
): Promise<{ success: boolean; reason?: string }> {
  try {
    const body = {tx: stringify(signedTx)}
    const injectUrl = proxyServerHost + '/inject'
    const waitTime = (signedTx.timestamp ?? 0) - Date.now()
    console.log(`Waiting for ${waitTime} ms before injecting transaction...`)
    if (waitTime > 0) await sleep(waitTime)
    const res = await axios.post(injectUrl, body)
    console.log('Liberdus tx inject response:', res.data)
    if (res.status !== 200 || res.data?.result?.success !== true)
      throw new Error(res.data?.result?.reason || 'Transaction injection failed')
    console.log('BridgeOut transaction sent successfully!', txId)
  } catch (e: any) {
    console.log('Error sending liberdus transaction:', txId, e.message)
    throw e
  }
  return {success: true}
}

async function processCoinToToken(
  to: string,
  value: ethers.BigNumber,
  txId: string,
  targetChainId: number,
  txTimestampMs: number,
  isRefund?: boolean,
  revertReason?: string,
): Promise<ProcessOutcome> {
  value = ethers.BigNumber.from(value)
  console.log('Processing coin to token transaction', {
    to,
    value: value.toString(),
    targetChainId,
    isRefund,
  })

  const chainState = chainStateByChainId.get(targetChainId)
  if (!chainState) {
    console.error(`[ProcessCoinToToken] Chain provider not found for chainId ${targetChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `chain provider not found for chainId ${targetChainId}`)
    return 'incompleted'
  }

  const targetChainName = chainState.config.name
  const tssSender = chainState.config.tssSenderAddress
  const normalizedTxId = normalizeTxId(txId)
  let senderNonce = getLocalNonce(targetChainId, tssSender)
  console.log(`Processing transaction on ${targetChainName}`)

  // Operator-imposed local limit check — fires before the on-chain check
  if (!isRefund) {
    const maxBridgeInAmountConfig = chainConfigs.liberdusBridgeGuards.maxBridgeInAmount
    const localMaxBridgeAmount = maxBridgeInAmountConfig !== "0" ? ethers.utils.parseEther(maxBridgeInAmountConfig) : null
    console.log(`[bridge-guards] BRIDGE_IN on ${targetChainName}: amount ${ethersUtils.formatEther(value)} LIB, local limit ${maxBridgeInAmountConfig !== "0" ? maxBridgeInAmountConfig : 'none'} LIB`)
    if (localMaxBridgeAmount && value.gt(localMaxBridgeAmount)) {
      console.warn(`[bridge-guards] BRIDGE_IN on ${targetChainName}: amount ${ethersUtils.formatEther(value)} LIB exceeds local limit ${maxBridgeInAmountConfig} LIB — initiating refund`)
      const revertReason = `Amount ${ethersUtils.formatEther(value)} LIB exceeds local BRIDGE_IN limit of ${maxBridgeInAmountConfig} LIB`
      return processTokenToCoin(to, value, txId, targetChainId, txTimestampMs, true, revertReason)
    }
  }

  if (!await checkMaxBridgeAmount(chainState, value)) {
    const reason = `Amount ${ethersUtils.formatEther(value)} exceeds bridge-in limit ${ethersUtils.formatEther(chainState.maxBridgeInAmount)}`
    console.error(`${reason} on ${targetChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.INCOMPLETED, '', tssSender, senderNonce as number, reason)
    pendingTxQueueRemovalSet.add(txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed on ${targetChainName}`)
    return 'incompleted'
  }
  // Fetch chain nonce and compare with local nonce manager
  const chainNonce = await getLatestChainNonce(targetChainId, tssSender)
  let localNonce = getLocalNonce(targetChainId, tssSender)

  if (localNonce != null && chainNonce > localNonce) {
    // Nonce drift — some txs with nonces in [localNonce, chainNonce) were mined without our knowledge
    console.warn(`[nonce-manager] Drift on ${targetChainName}: local=${localNonce}, chain=${chainNonce}`)
    const driftResult = reconcileNonceDrift(txId, targetChainId, tssSender, localNonce, chainNonce)
    syncLocalNonceFromDB('coinToToken', targetChainId, tssSender)
    if (driftResult.receiptId) {
      console.log(`[double-exec-guard] ${txId} was completed during nonce drift reconciliation`)
      return 'completed'
    }
    if (driftResult.latestDbNonce + 1 < chainNonce) {
      console.warn(`[nonce-drift] Gap on ${targetChainName} not yet resolved by observer, retrying later`)
      return 'incompleted'
    }
    // All drift nonces resolved — update localNonce and continue with this tx
    localNonce = getLocalNonce(targetChainId, tssSender)
  } else if (localNonce != null && localNonce > chainNonce) {
    // This shouldn't happen — local is ahead of chain
    console.warn(`[nonce-manager] Local nonce ahead of chain on ${targetChainName}: local=${localNonce}, chain=${chainNonce}`)
    // Abort this transaction to avoid potential double execution
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `local nonce ahead of chain on ${targetChainName}`)
    return 'incompleted'
  } else if (localNonce == null) {
    // First time — just sync
    setLocalNonce(targetChainId, tssSender, chainNonce)
    localNonce = getLocalNonce(targetChainId, tssSender)
  }

  // At this point, we have a valid local nonce that matches the chain nonce
  senderNonce = localNonce

  // Try rebroadcast from in-memory cache (same nonce = tx not yet mined)
  const cached = signedTxCache.get(normalizedTxId)
  if (cached && cached.nonce === senderNonce) {
    console.log(`[nonce-guard] Rebroadcasting cached signed tx for ${txId} nonce=${senderNonce}`)
    await fetchBridgeState(targetChainId)
    if (!await checkMaxBridgeAmount(chainState, value, true)) {
      const reason = `Amount ${ethersUtils.formatEther(value)} exceeds bridge-in limit ${ethersUtils.formatEther(chainState.maxBridgeInAmount)}`
      console.error(`${reason} on ${targetChainName} (post-sign)`)
      updateTxStatusInLocalDB(txId, TransactionStatus.INCOMPLETED, '', tssSender, senderNonce as number, reason)
      pendingTxQueueRemovalSet.add(txId)
      signedTxCache.delete(normalizedTxId)
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed post-sign on ${targetChainName}`)
      return 'incompleted'
    }
    const cooldownResult = await waitForBridgeCooldown(chainState, targetChainName, txId, cached.txHash)
    if (cooldownResult.outcome != null) {
      signedTxCache.delete(normalizedTxId)
      return cooldownResult.outcome
    }
    if (cooldownResult.receipt?.status === 1) {
      const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, cached.txHash, tssSender, senderNonce)
      signedTxCache.delete(normalizedTxId)
      if (updateResult === 'ok') incrementLocalNonce(targetChainId, tssSender)
      return 'completed'
    } else if (cooldownResult.receipt?.status === 0) {
      console.log(`[nonce-guard] Cached tx failed on ${targetChainName}: ${cached.txHash}`)
      const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, cached.txHash, tssSender, senderNonce)
      signedTxCache.delete(normalizedTxId)
      if (updateResult === 'ok') incrementLocalNonce(targetChainId, tssSender)
      return 'failed'
    }
    const preSubmit = reconcileTxStatusWithLocalDB(txId, 'pre-submit')
    if (preSubmit != null) {
      signedTxCache.delete(normalizedTxId)
      return dbStatusToSkipOutcome(preSubmit)
    }
    try {
      await retryOperation(() => injectEthereumTx(targetChainId, cached.txHash, cached.signedTx), {
        txId: cached.txHash,
        maxRetries: 3,
      })
      updateTxStatusInLocalDB(txId, TransactionStatus.SUBMITTED, cached.txHash, tssSender, senderNonce, '')
      const cachedReceipt = await getChainTransactionReceipt(targetChainId, cached.txHash)
      if (cachedReceipt?.status === 1) {
        const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, cached.txHash, tssSender, senderNonce)
        signedTxCache.delete(normalizedTxId)
        if (updateResult === 'ok') incrementLocalNonce(targetChainId, tssSender)
        return 'completed'
      } else if (cachedReceipt?.status === 0) {
        console.log(`[nonce-guard] Cached tx failed on ${targetChainName}: ${cached.txHash}`)
        const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, cached.txHash, tssSender, senderNonce)
        signedTxCache.delete(normalizedTxId)
        if (updateResult === 'ok') incrementLocalNonce(targetChainId, tssSender)
        return 'failed'
      }
    } catch (e) {
      console.warn(`[nonce-guard] Rebroadcast failed, will re-sign: ${e instanceof Error ? e.message : e}`)
    }
  } else if (cached) {
    // Nonce changed — cached tx is stale
    signedTxCache.delete(normalizedTxId)
  }

  let currentGasPrice = await getGasPriceFromFixedRpc(chainState.config.rpcUrl)
  console.log(`[gas] ${targetChainName} live gas price: ${ethersUtils.formatUnits(currentGasPrice, 'gwei')} gwei`)

  // Apply gas price logic based on chain configuration
  for (const tierGwei of chainState.gasPriceTiersBN) {
    if (currentGasPrice.lte(tierGwei)) {
      currentGasPrice = tierGwei
      break
    }
  }
  console.log(`[gas] ${targetChainName} final gas price: ${ethersUtils.formatUnits(currentGasPrice, 'gwei')} gwei`)

  const txIdBytes32 = txId.startsWith('0x') ? txId : '0x' + txId
  const data = BRIDGE_CONTRACT_IFACE.encodeFunctionData('bridgeIn', [
    toEthereumAddress(to),
    value,
    targetChainId,
    txIdBytes32,
  ])
  const bridgeInContractAddress = chainState.config.contractAddress
  const tx = {
    to: bridgeInContractAddress,
    value: 0,
    data,
    nonce: senderNonce,
    gasLimit: chainState.config.gasConfig.gasLimit,
    gasPrice: currentGasPrice,
    chainId: toNetworkChainId(targetChainId),
  }
  console.log(`eth tx to sign on ${targetChainName}`, tx)
  const unsignedTx = ethersUtils.serializeTransaction(tx)
  let digest = ethersUtils.keccak256(unsignedTx)
  const channelId = deriveDeterministicChannelId(normalizeTxId(txId), txTimestampMs)
  const channelPassword = deriveDeterministicChannelPassword(channelId, cryptoInitKey)

  const preSign = reconcileTxStatusWithLocalDB(txId, 'pre-sign')
  if (preSign != null) return dbStatusToSkipOutcome(preSign)

  // Sign via TSS (Use target chain provider  for signing)
  const signedTx = await signEthereumTransaction(tx, digest, targetChainId, channelId, channelPassword)
  if (!signedTx) {
    console.log(`Failed to sign Ethereum transaction on ${targetChainName}, skipping`, txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `failed to sign Ethereum transaction on ${targetChainName}`)
    return 'incompleted'
  }

  const txHash = ethersUtils.keccak256(signedTx as string)
  // Cache signed tx early so retries can reuse it.
  signedTxCache.set(normalizedTxId, { signedTx: signedTx as string, txHash, nonce: senderNonce, cachedAt: Date.now() })

  const postSign = reconcileTxStatusWithLocalDB(txId, 'post-sign')
  if (postSign != null) {
    signedTxCache.delete(normalizedTxId)
    return dbStatusToSkipOutcome(postSign)
  }

  await fetchBridgeState(targetChainId)
  if (!await checkMaxBridgeAmount(chainState, value, true)) {
    const reason = `Amount ${ethersUtils.formatEther(value)} exceeds bridge-in limit ${ethersUtils.formatEther(chainState.maxBridgeInAmount)}`
    console.error(`${reason} on ${targetChainName} (post-sign)`)
    updateTxStatusInLocalDB(txId, TransactionStatus.INCOMPLETED, '', tssSender, senderNonce as number, reason)
    pendingTxQueueRemovalSet.add(txId)
    signedTxCache.delete(normalizedTxId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed post-sign on ${targetChainName}`)
    return 'incompleted'
  }
  const cooldownResult = await waitForBridgeCooldown(chainState, targetChainName, txId, txHash)
  if (cooldownResult.outcome != null) {
    signedTxCache.delete(normalizedTxId)
    return cooldownResult.outcome
  }
  if (cooldownResult.receipt?.status === 1) {
    const finalStatus = isRefund ? TransactionStatus.REVERTED : TransactionStatus.COMPLETED
    const finalOutcome: ProcessOutcome = isRefund ? 'reverted' : 'completed'
    console.log(
      `Transaction is successful - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}${isRefund ? ' (refund)' : ''}`,
    )
    const updateResult = updateTxStatusInLocalDB(txId, finalStatus, txHash, tssSender, senderNonce, isRefund ? revertReason ?? '' : '')
    signedTxCache.delete(normalizedTxId)
    if (updateResult === 'ok') incrementLocalNonce(targetChainId, tssSender)
    return finalOutcome
  } else if (cooldownResult.receipt?.status === 0) {
    console.log(
      `Transaction failed in execution - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `failed in execution on ${targetChainName}`)
    const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, txHash, tssSender, senderNonce, '')
    signedTxCache.delete(normalizedTxId)
    if (updateResult === 'ok') incrementLocalNonce(targetChainId, tssSender)
    return 'failed'
  }

  const preSubmit = reconcileTxStatusWithLocalDB(txId, 'pre-submit')
  if (preSubmit != null) {
    signedTxCache.delete(normalizedTxId)
    return dbStatusToSkipOutcome(preSubmit)
  }

  console.log(`Injecting ethereum transaction on ${targetChainName}`, txHash)

  let res: { success: boolean; reason?: string }
  // Retry injection with linear delay progression
  try {
    res = await retryOperation(() => injectEthereumTx(targetChainId, txHash, signedTx), {
      txId: txHash,
      maxRetries: 3,
    })
    console.log(`Ethereum transaction injected on ${targetChainName}`, txHash, res)
  } catch (error) {
    const reason = error instanceof Error ? error.message : (error as string)
    console.error(`Failed to inject ethereum transaction on ${targetChainName}: ${txHash}`, reason)
    res = {success: false, reason}
    await refreshBridgeStateOnFailed(reason, targetChainId)
  }

  if (res.success) {
    updateTxStatusInLocalDB(txId, TransactionStatus.SUBMITTED, txHash, tssSender, senderNonce, '')
  }

  let receipt: ethers.providers.TransactionReceipt | null = null
  try {
    receipt = await getChainTransactionReceipt(targetChainId, txHash)
    if (!receipt) {
      // Tx may have been broadcast but not yet mined — retry once after a short delay
      await delay_ms(3000)
      receipt = await getChainTransactionReceipt(targetChainId, txHash)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`Failed to fetch receipt for ethereum transaction on ${targetChainName}: ${txHash}`, reason)
  }
  if (receipt) {
    console.log(`[receipt] Found Ethereum receipt on ${targetChainName} for ${txHash}: status=${receipt.status} block=${receipt.blockNumber}`)
    if (receipt.status === 1) {
      const finalStatus = isRefund ? TransactionStatus.REVERTED : TransactionStatus.COMPLETED
      const finalOutcome: ProcessOutcome = isRefund ? 'reverted' : 'completed'
      console.log(
        `Transaction is successful - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}${isRefund ? ' (refund)' : ''}`,
      )
      const updateResult = updateTxStatusInLocalDB(txId, finalStatus, txHash, tssSender, senderNonce, isRefund ? revertReason ?? '' : '')
      signedTxCache.delete(normalizedTxId)
      if (updateResult === 'ok') incrementLocalNonce(targetChainId, tssSender)
      return finalOutcome
    } else {
      console.log(
        `Transaction failed in execution - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, `failed in execution on ${targetChainName}`)
      const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, txHash, tssSender, senderNonce, '')
      signedTxCache.delete(normalizedTxId)
      if (updateResult === 'ok') incrementLocalNonce(targetChainId, tssSender)  // nonce consumed even on on-chain failure
      return 'failed'
    }
  } else {
    console.log(
      `Transaction incompleted - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      res.reason,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send incompleted on ${targetChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.INCOMPLETED, txHash, tssSender, senderNonce, res.reason as string)
    pendingTxQueueRemovalSet.add(txId)
    // Don't increment nonce — tx may not have been broadcast/mined
    // signedTxCache is NOT cleared — we may want to rebroadcast on next attempt
    return 'incompleted'
  }
}

async function processVaultBridge(
  to: string,
  value: ethers.BigNumber,
  txId: string,
  sourceChainId: number,
  destinationChainId: number,
  txTimestampMs: number,
): Promise<ProcessOutcome> {
  value = ethers.BigNumber.from(value)
  console.log('Processing vault bridge transaction', {
    to,
    value: value.toString(),
    sourceChainId,
    destinationChainId,
  })

  const sourceChainState = chainStateByChainId.get(sourceChainId)
  if (!sourceChainState) {
    console.error(`Source chain provider not found for chainId ${sourceChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `source chain provider not found for chainId ${sourceChainId}`)
    return 'incompleted'
  }

  const destChainState = chainStateByChainId.get(destinationChainId)
  if (!destChainState) {
    console.error(`Destination chain provider not found for chainId ${destinationChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `destination chain provider not found for chainId ${destinationChainId}`)
    return 'incompleted'
  }

  const sourceChainName = sourceChainState.config.name
  const destChainName = destChainState.config.name
  const tssSender = destChainState.config.tssSenderAddress
  const normalizedTxId = normalizeTxId(txId)
  let senderNonce = getLocalNonce(destinationChainId, tssSender)

  console.log(`Processing vault bridge: ${sourceChainName} -> ${destChainName}`)

  if (!await checkMaxBridgeAmount(destChainState, value)) {
    const reason = `Amount ${ethersUtils.formatEther(value)} exceeds bridge-in limit ${ethersUtils.formatEther(destChainState.maxBridgeInAmount)}`
    console.error(`${reason} on ${destChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.INCOMPLETED, '', tssSender, senderNonce, reason)
    pendingTxQueueRemovalSet.add(txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed on ${destChainName}`)
    return 'incompleted'
  }
  // Fetch chain nonce and compare with local nonce manager
  const chainNonce = await getLatestChainNonce(destinationChainId, tssSender)
  let localNonce = getLocalNonce(destinationChainId, tssSender)

  if (localNonce != null && chainNonce > localNonce) {
    // Nonce drift — some txs with nonces in [localNonce, chainNonce) were mined without our knowledge
    console.warn(`[nonce-manager] Drift on ${destChainName}: local=${localNonce}, chain=${chainNonce}`)
    // For vault bridge, sourceChainId is the DB key for nonce lookups
    const driftResult = reconcileNonceDrift(txId, sourceChainId, tssSender, localNonce, chainNonce)
    syncLocalNonceFromDB('vaultBridge', sourceChainId, tssSender)
    if (driftResult.receiptId) {
      console.log(`[double-exec-guard] ${txId} was completed during nonce drift reconciliation`)
      return 'completed'
    }
    if (driftResult.latestDbNonce + 1 < chainNonce) {
      console.warn(`[nonce-drift] Gap on ${destChainName} not yet resolved by observer, retrying later`)
      return 'incompleted'
    }
    // All drift nonces resolved — update localNonce and continue with this tx
    localNonce = getLocalNonce(destinationChainId, tssSender)
  } else if (localNonce != null && localNonce > chainNonce) {
    // This shouldn't happen — local is ahead of chain
    console.warn(`[nonce-manager] Local nonce ahead of chain on ${destChainName}: local=${localNonce}, chain=${chainNonce}`)
    // Abort this transaction to avoid potential double execution
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `local nonce ahead of chain on ${destChainName}`)
    return 'incompleted'
  } else if (localNonce == null) {
    // First time — just sync
    setLocalNonce(destinationChainId, tssSender, chainNonce)
    localNonce = getLocalNonce(destinationChainId, tssSender)
  }

  // At this point, we have a valid local nonce that matches the chain nonce
  senderNonce = localNonce

  // Try rebroadcast from in-memory cache (same nonce = tx not yet mined)
  const cached = signedTxCache.get(normalizedTxId)
  if (cached && cached.nonce === senderNonce) {
    console.log(`[nonce-guard] Rebroadcasting cached signed tx for ${txId} nonce=${senderNonce}`)
    await fetchBridgeState(destinationChainId)
    if (!await checkMaxBridgeAmount(destChainState, value, true)) {
      const reason = `Amount ${ethersUtils.formatEther(value)} exceeds bridge-in limit ${ethersUtils.formatEther(destChainState.maxBridgeInAmount)}`
      console.error(`${reason} on ${destChainName} (post-sign)`)
      updateTxStatusInLocalDB(txId, TransactionStatus.INCOMPLETED, '', tssSender, senderNonce as number, reason)
      pendingTxQueueRemovalSet.add(txId)
      signedTxCache.delete(normalizedTxId)
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed post-sign on ${destChainName}`)
      return 'incompleted'
    }
    const cooldownResult = await waitForBridgeCooldown(destChainState, destChainName, txId, cached.txHash)
    if (cooldownResult.outcome != null) {
      signedTxCache.delete(normalizedTxId)
      return cooldownResult.outcome
    }
    if (cooldownResult.receipt?.status === 1) {
      const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, cached.txHash, tssSender, senderNonce)
      signedTxCache.delete(normalizedTxId)
      if (updateResult === 'ok') incrementLocalNonce(destinationChainId, tssSender)
      return 'completed'
    } else if (cooldownResult.receipt?.status === 0) {
      console.log(`[nonce-guard] Cached tx failed on ${destChainName}: ${cached.txHash}`)
      const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, cached.txHash, tssSender, senderNonce)
      signedTxCache.delete(normalizedTxId)
      if (updateResult === 'ok') incrementLocalNonce(destinationChainId, tssSender)
      return 'failed'
    }
    const preSubmit = reconcileTxStatusWithLocalDB(txId, 'pre-submit')
    if (preSubmit != null) {
      signedTxCache.delete(normalizedTxId)
      return dbStatusToSkipOutcome(preSubmit)
    }
    try {
      await retryOperation(() => injectEthereumTx(destinationChainId, cached.txHash, cached.signedTx), {
        txId: cached.txHash,
        maxRetries: 3,
      })
      updateTxStatusInLocalDB(txId, TransactionStatus.SUBMITTED, cached.txHash, tssSender, senderNonce, '')
      const receipt = await getChainTransactionReceipt(destinationChainId, cached.txHash)
      if (receipt?.status === 1) {
        const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, cached.txHash, tssSender, senderNonce)
        signedTxCache.delete(normalizedTxId)
        if (updateResult === 'ok') incrementLocalNonce(destinationChainId, tssSender)
        return 'completed'
      } else if (receipt?.status === 0) {
        console.log(`[nonce-guard] Cached tx failed on ${destChainName}: ${cached.txHash}`)
        const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, cached.txHash, tssSender, senderNonce)
        signedTxCache.delete(normalizedTxId)
        if (updateResult === 'ok') incrementLocalNonce(destinationChainId, tssSender)
        return 'failed'
      }
    } catch (e) {
      console.warn(`[nonce-guard] Rebroadcast failed, will re-sign: ${e instanceof Error ? e.message : e}`)
    }
  } else if (cached) {
    signedTxCache.delete(normalizedTxId)
  }

  let currentGasPrice = await getGasPriceFromFixedRpc(destChainState.config.rpcUrl)
  console.log(`[gas] ${destChainName} live gas price: ${ethersUtils.formatUnits(currentGasPrice, 'gwei')} gwei`)

  // Apply gas price logic based on destination chain configuration
  for (const tierGwei of destChainState.gasPriceTiersBN) {
    if (currentGasPrice.lte(tierGwei)) {
      currentGasPrice = tierGwei
      break
    }
  }
  console.log(`[gas] ${destChainName} final gas price: ${ethersUtils.formatUnits(currentGasPrice, 'gwei')} gwei`)

  const txIdBytes32 = txId.startsWith('0x') ? txId : '0x' + txId
  const data = BRIDGE_CONTRACT_IFACE.encodeFunctionData('bridgeIn', [
    to,
    value,
    destinationChainId,
    txIdBytes32,
  ])

  const bridgeInContractAddress = destChainState.config.contractAddress
  const tx = {
    to: bridgeInContractAddress,
    value: 0,
    data,
    nonce: senderNonce,
    gasLimit: destChainState.config.gasConfig.gasLimit,
    gasPrice: currentGasPrice,
    chainId: toNetworkChainId(destChainState.config.chainId),
  }
  console.log(`EVM-to-EVM tx to sign on ${destChainName}`, tx)
  const unsignedTx = ethersUtils.serializeTransaction(tx)
  let digest = ethersUtils.keccak256(unsignedTx)
  const channelId = deriveDeterministicChannelId(normalizeTxId(txId), txTimestampMs)
  const channelPassword = deriveDeterministicChannelPassword(channelId, cryptoInitKey)

  const preSign = reconcileTxStatusWithLocalDB(txId, 'pre-sign')
  if (preSign != null) return dbStatusToSkipOutcome(preSign)

  // Sign via TSS (destination chain keystore)
  const signedTx = await signEthereumTransaction(tx, digest, destinationChainId, channelId, channelPassword)
  if (!signedTx) {
    console.log(`Failed to sign EVM-to-EVM transaction on ${destChainName}, skipping`, txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `failed to sign EVM-to-EVM transaction on ${destChainName}`)
    return 'incompleted'
  }

  const txHash = ethersUtils.keccak256(signedTx as string)
  // Cache signed tx early so retries can reuse it.
  signedTxCache.set(normalizedTxId, { signedTx: signedTx as string, txHash, nonce: senderNonce, cachedAt: Date.now() })

  const postSign = reconcileTxStatusWithLocalDB(txId, 'post-sign')
  if (postSign != null) {
    signedTxCache.delete(normalizedTxId)
    return dbStatusToSkipOutcome(postSign)
  }

  await fetchBridgeState(destinationChainId)
  if (!await checkMaxBridgeAmount(destChainState, value, true)) {
    const reason = `Amount ${ethersUtils.formatEther(value)} exceeds bridge-in limit ${ethersUtils.formatEther(destChainState.maxBridgeInAmount)}`
    console.error(`${reason} on ${destChainName} (post-sign)`)
    updateTxStatusInLocalDB(txId, TransactionStatus.INCOMPLETED, '', tssSender, senderNonce as number, reason)
    pendingTxQueueRemovalSet.add(txId)
    signedTxCache.delete(normalizedTxId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed post-sign on ${destChainName}`)
    return 'incompleted'
  }
  const cooldownResult = await waitForBridgeCooldown(destChainState, destChainName, txId, txHash)
  if (cooldownResult.outcome != null) {
    signedTxCache.delete(normalizedTxId)
    return cooldownResult.outcome
  }
  if (cooldownResult.receipt?.status === 1) {
    console.log(
      `EVM-to-EVM transaction successful - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
    )
    const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, txHash, tssSender, senderNonce, '')
    signedTxCache.delete(normalizedTxId)
    if (updateResult === 'ok') incrementLocalNonce(destinationChainId, tssSender)
    return 'completed'
  } else if (cooldownResult.receipt?.status === 0) {
    console.log(
      `EVM-to-EVM transaction failed in execution - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `failed in execution on ${destChainName}`)
    const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, txHash, tssSender, senderNonce, '')
    signedTxCache.delete(normalizedTxId)
    if (updateResult === 'ok') incrementLocalNonce(destinationChainId, tssSender)
    return 'failed'
  }

  const preSubmit = reconcileTxStatusWithLocalDB(txId, 'pre-submit')
  if (preSubmit != null) {
    signedTxCache.delete(normalizedTxId)
    return dbStatusToSkipOutcome(preSubmit)
  }

  console.log(`Injecting EVM-to-EVM transaction on ${destChainName}`, txHash)
  let res: { success: boolean; reason?: string }

  if (DEBUG_SIMULATE_NONCE_DRIFT) return 'incompleted'

  // Retry injection with linear delay progression
  try {
    res = await retryOperation(() => injectEthereumTx(destinationChainId, txHash, signedTx), {
      txId: txHash,
      maxRetries: 3,
    })
    console.log(`EVM-to-EVM transaction injected on ${destChainName}`, txHash, res)
  } catch (error) {
    const reason = error instanceof Error ? error.message : (error as string)
    console.error(`Failed to inject EVM-to-EVM transaction on ${destChainName}: ${txHash}`, reason)
    res = {success: false, reason}
    await refreshBridgeStateOnFailed(reason, destinationChainId)
  }

  if (res.success) {
    updateTxStatusInLocalDB(txId, TransactionStatus.SUBMITTED, txHash, tssSender, senderNonce, '')
  }

  let receipt: ethers.providers.TransactionReceipt | null = null
  try {
    receipt = await getChainTransactionReceipt(destinationChainId, txHash)
    if (!receipt) {
      // Tx may have been broadcast but not yet mined — retry once after a short delay
      await delay_ms(3000)
      receipt = await getChainTransactionReceipt(destinationChainId, txHash)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`Failed to fetch receipt for EVM-to-EVM transaction on ${destChainName}: ${txHash}`, reason)
  }
  if (receipt) {
    console.log(`[receipt] Found EVM-to-EVM receipt on ${destChainName} for ${txHash}: status=${receipt.status} block=${receipt.blockNumber}`)
    if (receipt.status === 1) {
      console.log(
        `EVM-to-EVM transaction successful - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      )
      const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, txHash, tssSender, senderNonce, '')
      signedTxCache.delete(normalizedTxId)
      if (updateResult === 'ok') incrementLocalNonce(destinationChainId, tssSender)
      return 'completed'
    } else {
      console.log(
        `EVM-to-EVM transaction failed in execution - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, `failed in execution on ${destChainName}`)
      const updateResult = updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, txHash, tssSender, senderNonce, '')
      signedTxCache.delete(normalizedTxId)
      if (updateResult === 'ok') incrementLocalNonce(destinationChainId, tssSender)  // nonce consumed even on on-chain failure
      return 'failed'
    }
  } else {
    console.log(
      `EVM-to-EVM transaction incompleted - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      res.reason,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send incompleted on ${destChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.INCOMPLETED, txHash, tssSender, senderNonce, res.reason as string)
    pendingTxQueueRemovalSet.add(txId)
    // Don't increment nonce — tx may not have been broadcast/mined
    // signedTxCache is NOT cleared — we may want to rebroadcast on next attempt
    return 'incompleted'
  }
}

async function processTokenToCoin(
  to: string,
  value: any,
  txId: string,
  sourceChainId: number,
  txTimestampMs: number,
  isRefund?: boolean,
  revertReason?: string,
): Promise<ProcessOutcome> {
  console.log('Processing token to coin transaction', {to, value, txId, sourceChainId})

  const sourceChainState = chainStateByChainId.get(sourceChainId)
  if (!sourceChainState) {
    console.error(`[ProcessTokenToCoin] Source chain provider not found for chainId ${sourceChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `source chain provider not found for chainId ${sourceChainId}`)
    return 'incompleted'
  }

  const sourceChainName = sourceChainState.config.name
  console.log(`Processing transaction from ${sourceChainName}`, { isRefund: isRefund })

  // Operator-imposed local limit check — only on non-refund calls
  if (!isRefund) {
    const valueBN = ethers.BigNumber.from(value.toHexString())
    const maxBridgeOutAmountConfig = chainConfigs.liberdusBridgeGuards.maxBridgeOutAmount
    const localMaxBridgeAmount = maxBridgeOutAmountConfig !== "0" ? ethers.utils.parseEther(maxBridgeOutAmountConfig) : null
    console.log(`[bridge-guards] BRIDGE_OUT from ${sourceChainName}: amount ${ethersUtils.formatEther(valueBN)} LIB, local limit ${maxBridgeOutAmountConfig !== "0" ? maxBridgeOutAmountConfig : 'none'} LIB`)
    if (localMaxBridgeAmount && valueBN.gt(localMaxBridgeAmount)) {
      console.warn(`[bridge-guards] BRIDGE_OUT from ${sourceChainName}: amount ${ethersUtils.formatEther(valueBN)} LIB exceeds local limit ${maxBridgeOutAmountConfig} LIB — initiating refund`)
      const revertReason = `Amount ${ethersUtils.formatEther(valueBN)} LIB exceeds local BRIDGE_OUT limit of ${maxBridgeOutAmountConfig} LIB`
      // Observer stores the BRIDGE_OUT targetAddress as transaction.sender; refund assumes it matches the original sender.
      return processCoinToToken(to, valueBN, txId, sourceChainId, txTimestampMs, true, revertReason)
    }

    if (chainConfigs.liberdusBridgeGuards.enforceRecipientExists) {
      const shardusTo = toShardusAddress(to)
      const accountCheck = await checkLiberdusAccountExists(shardusTo)
      console.log(`[bridge-guards] BRIDGE_OUT from ${sourceChainName}: recipient account ${shardusTo} — ${accountCheck}`)
      if (accountCheck === 'not-found') {
        console.warn(`[bridge-guards] BRIDGE_OUT from ${sourceChainName}: recipient ${shardusTo} does not exist on Liberdus network — initiating refund`)
        const revertReason = `Recipient ${shardusTo} does not exist on Liberdus network`
        // Observer stores the BRIDGE_OUT targetAddress as transaction.sender; refund assumes it matches the original sender.
        return processCoinToToken(to, valueBN, txId, sourceChainId, txTimestampMs, true, revertReason)
      }
      if (accountCheck === 'error') {
        console.warn(`[bridge-guards] BRIDGE_OUT from ${sourceChainName}: could not verify recipient ${shardusTo} — retrying later`)
        return 'incompleted'
      }
    }
  }

  // convert ethers.BigNumber to bigint
  const amountInBigInt = BigInt(value.toHexString())
  console.log('Amount in bigint:', amountInBigInt)
  let signedTx: SignedTx | null = null
  const tx: LiberdusTx = {
    from: toShardusAddress(sourceChainState.config.tssSenderAddress),
    to: toShardusAddress(to),
    amount: amountInBigInt,
    type: 'transfer',
    networkId: chainConfigs.liberdusNetworkId,
    // memo: `${txId}:${sourceChainId}`, // Include source chain info in memo
  }
  tx.chatId = calculateChatId(tx.from, tx.to)
  const currentCycleRecord = await getLatestCycleRecord()
  tx.timestamp = deriveLocalFutureTimestamp(currentCycleRecord)
  console.log(
    `Current timestamp: ${new Date(Date.now())}, Future timestamp: ${new Date(tx.timestamp)}, Wait time: ${tx.timestamp - Date.now()}`,
  )
  console.log('Transaction:', tx)
  const hashMessage = crypto.hashObj(tx)
  let digest = ethersUtils.hashMessage(hashMessage)
  const channelId = deriveDeterministicChannelId(normalizeTxId(txId), txTimestampMs)
  const channelPassword = deriveDeterministicChannelPassword(channelId, cryptoInitKey)

  const preSign = reconcileTxStatusWithLocalDB(txId, 'pre-sign')
  if (preSign != null) return dbStatusToSkipOutcome(preSign)

  // Use chain-specific keystore for signing (source chain for Liberdus transactions)
  signedTx = await signLiberdusTransaction(tx, digest, sourceChainId, channelId, channelPassword)
  if (!signedTx) {
    console.log(`Failed to sign liberdus transaction from ${sourceChainName}, skipping`, txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `failed to sign liberdus transaction from ${sourceChainName}`)
    return 'incompleted'
  }
  // Compute txId from signedTx
  const signedTxId = crypto.hashObj(signedTx as SignedTx, true)
  console.log('Transaction Id:', signedTxId)
  let res: { success: boolean; reason?: string }
  // Retry injection with linear delay progression
  try {
    res = await retryOperation(() => injectLiberdusTx(signedTxId, signedTx as SignedTx), {
      txId: signedTxId,
      maxRetries: 3,
    })
    console.log(`Liberdus transaction injected from ${sourceChainName}`, signedTxId, res)
  } catch (error) {
    const reason = error instanceof Error ? error.message : (error as string)
    console.error(
      `Failed to inject liberdus transaction from ${sourceChainName}: ${signedTxId}`,
      reason,
    )

    res = {success: false, reason}
  }

  const liberdusTssSender = sourceChainState.config.tssSenderAddress
  const liberdusNonce = tx.timestamp

  if (res.success) {
    updateTxStatusInLocalDB(txId, TransactionStatus.SUBMITTED, signedTxId, liberdusTssSender, liberdusNonce, '')
  }

  let fetchReceiptRetry = 3
  if (res.success === true) {
    fetchReceiptRetry = 10 // Higher retries for successful transactions
  }

  await sleep(5000) // wait for 5 seconds

  const receipt = await getLiberdusReceipt(signedTxId, fetchReceiptRetry)
  if (receipt) {
    if (receipt.success === true) {
      const finalStatus = isRefund ? TransactionStatus.REVERTED : TransactionStatus.COMPLETED
      const finalOutcome: ProcessOutcome = isRefund ? 'reverted' : 'completed'
      console.log(
        `Transaction is successful - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId}${isRefund ? ' (refund)' : ''}`,
      )
      updateTxStatusInLocalDB(txId, finalStatus, signedTxId, liberdusTssSender, liberdusNonce, isRefund ? revertReason ?? '' : '')
      return finalOutcome
    } else {
      console.log(
        `Transaction failed in execution - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId} with reason ${receipt.reason}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, receipt.reason)
      updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, signedTxId, liberdusTssSender, liberdusNonce, receipt.reason)
      return 'failed'
    }
  } else {
    console.log(
      `Transaction incompleted - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId} with reason ${res.reason}`,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send incompleted from ${sourceChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.INCOMPLETED, signedTxId, liberdusTssSender, liberdusNonce, res.reason as string)
    pendingTxQueueRemovalSet.add(txId)
    return 'incompleted'
  }
}

// Retry function with linear delay progression
async function retryOperation<T>(
  operation: () => Promise<T>,
  options: {
    txId: string // Used for logging purposes
    maxRetries: number
    shouldRetry?: (error: Error) => boolean
  },
): Promise<T> {
  const {
    txId,
    maxRetries = 3,
    shouldRetry = (error: Error) => {
      const msg = error.message
      // Never retry these errors — they will fail again with the same result
      const nonRetryablePatterns = [
        // Signature / auth errors
        'invalid signature',
        // Nonce errors (nonce already consumed by this or another server)
        'Nonce too low',
        'nonce has already been used',
        'NONCE_EXPIRED',
        // Contract execution failures (retrying won't help)
        'reverted with reason string',
        'execution reverted',
        'CALL_EXCEPTION',
        'Transaction Failed',
        // Insufficient funds for gas
        'insufficient funds',
        'INSUFFICIENT_FUNDS',
        // Liberdus: tx already accepted by the network, no need to retry
        'Transaction is already in queue',
        // EVM tx already accepted by the mempool
        'already known',
      ]
      return !nonRetryablePatterns.some((pattern) => msg.includes(pattern))
    },
  } = options

  let lastError: Error

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation()
      return result
    } catch (error) {
      lastError = error as Error

      // Force garbage collection of error objects on final attempt
      if (global.gc && attempt === maxRetries) {
        tryGC()
      }

      if (!shouldRetry(lastError) || attempt === maxRetries) {
        console.log(
          `[${txId}] Failed after ${attempt} ${attempt === 1 ? 'attempt' : `attempts`} `,
          lastError.message,
        )
        throw lastError
      }

      const delay = attempt * 1000
      console.log(`[${txId}] Attempt ${attempt + 1} failed, retrying in ${delay}ms`)

      if (delay > 0) await sleep(delay)
    }
  }

  throw lastError!
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Add memory monitoring function
function logMemoryUsage() {
  const usage = process.memoryUsage()
  const formatMB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`
  
  console.log(`📊 Memory Usage: {rss: ${formatMB(usage.rss)}, heapTotal: ${formatMB(usage.heapTotal)}, heapUsed: ${formatMB(usage.heapUsed)}, external: ${formatMB(usage.external)}, txQueueMapSize: ${txQueueMap.size}, processingSize: ${processingTransactionIds.size}, pendingTxQueueLength: ${pendingTxQueue.length}}`)
  
  // More aggressive memory management thresholds
  const heapUsedMB = usage.heapUsed / 1024 / 1024
  const rssMB = usage.rss / 1024 / 1024
  
  // Force garbage collection if memory usage is high (lower thresholds)
  if (heapUsedMB > 500 && global.gc) { // Raised from 40MB — Node.js baseline overhead makes lower thresholds fire constantly
    console.log('⚠️ High heap usage detected, forcing garbage collection')
    const beforeGC = usage.heapUsed
    tryGC()
    
    // Log memory after GC
    const afterGC = process.memoryUsage()
    const freedMB = Math.round((beforeGC - afterGC.heapUsed) / 1024 / 1024)
    console.log('🗑️ Memory after GC:', {
      heapUsed: formatMB(afterGC.heapUsed),
      freed: `${freedMB} MB`
    })
  }
  
  // Monitor RSS memory growth (resident set size - actual memory usage)
  if (rssMB > 1024) { // Alert if RSS exceeds 1GB
    console.warn(`⚠️ High RSS memory usage: ${formatMB(usage.rss)}. Triggering aggressive cleanup.`)
    cleanupOldTransactions()
    if (global.gc) {
      tryGC()
    }
  }
  
  // Warn about potential memory leaks
  if (txQueueMap.size > 2000) {
    console.warn(`⚠️ Large txQueueMap detected: ${txQueueMap.size} entries. Check for stale data.`)
  }

  if (processingTransactionIds.size > MAX_CONCURRENT_TXS) {
    console.warn(`⚠️ processingTransactionIds has ${processingTransactionIds.size} entries, expected ≤ ${MAX_CONCURRENT_TXS}.`)
  }
}

// Add post-transaction memory monitoring
function checkPostTransactionMemory(txId: string, operationType: string) {
  const usage = process.memoryUsage()
  const formatMB = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`
  const heapUsedMB = usage.heapUsed / 1024 / 1024
  const rssMB = usage.rss / 1024 / 1024
  
  console.log(`📈 Post-${operationType} memory for ${txId}:`, {
    rss: formatMB(usage.rss),
    heapUsed: formatMB(usage.heapUsed)
  })
  
  // If memory usage spiked after transaction, force cleanup
  if (heapUsedMB > 500 || rssMB > 1024) {
    console.warn(`🚨 Memory spike detected after ${operationType} (${txId}). Forcing immediate cleanup.`)
    if (global.gc) {
      tryGC()
      
      // Log memory after forced GC
      const afterGC = process.memoryUsage()
      console.log(`💨 Memory after forced GC:`, {
        rss: formatMB(afterGC.rss),
        heapUsed: formatMB(afterGC.heapUsed),
        freed: `${Math.round((usage.heapUsed - afterGC.heapUsed) / 1024 / 1024)} MB`
      })
    }
  }
}


// Add emergency cleanup function for when queues get too large
function emergencyCleanup() {
  const now = Date.now()
  let removedCount = 0
  let backupCount = 0
  const removedTxIds = new Set<string>()
  
  console.log('🚨 Running emergency cleanup due to large queue size')
  

  // Create an additional emergency backup with timestamp
  const emergencyBackupPath = path.join(KEYSTORE_DIR, `emergency_backup_party_${ourParty.idx}_${now}.json`)
  const backupData = {
    timestamp: now,
    reason: 'emergency_cleanup',
    originalSize: txQueueMap.size,
    pending: pendingTxQueue.map(tx => ({ ...tx, value: tx.value.toString(), receipt: undefined })),
    map: Array.from(txQueueMap.entries()),
  }
  
  try {
    fs.writeFileSync(emergencyBackupPath, JSON.stringify(backupData, null, 2))
    console.log(`💾 Emergency backup created: ${emergencyBackupPath}`)
  } catch (error) {
    console.error('❌ Failed to create emergency backup:', error)
    // Don't proceed with cleanup if we can't backup
    console.error('🛑 Aborting emergency cleanup due to backup failure')
    return
  }
  
  backupCount = pendingTxQueue.length

  // Aggressive cleanup — remove anything older than 1h
  for (const [txId, entry] of txQueueMap.entries()) {
    const txAge = entry.txTimestamp > 0 ? now - entry.txTimestamp : now - serverStartTime
    if (txAge > TX_CLEANUP_MAX_AGE) {
      txQueueMap.delete(txId)
      processingTransactionIds.delete(txId)
      removedTxIds.add(txId)
      removedCount++
    }
  }

  if (removedTxIds.size > 0) {
    for (let i = pendingTxQueue.length - 1; i >= 0; i--) {
      if (removedTxIds.has(pendingTxQueue[i].txId)) {
        appendToFailedTxsLogs(
          pendingTxQueue[i],
          'removed from pending queue during emergency cleanup due to max age',
        )
        pendingTxQueue.splice(i, 1)
      }
    }
  }
  
  console.log(`🚨 Emergency cleanup removed ${removedCount} old transactions`)
  console.log(`💾 Backed up ${backupCount} pending transactions to: ${emergencyBackupPath}`)
  
  // Force GC after emergency cleanup
  if (global.gc) {
    tryGC()
    console.log('🗑️ Forced garbage collection after emergency cleanup')
  }
}

// Add function to clean up stuck transactions
function cleanupStuckTransactions() {
  if (processingTransactionIds.size > MAX_CONCURRENT_TXS) {
    console.warn(`⚠️ processingTransactionIds has ${processingTransactionIds.size} entries, expected ≤ ${MAX_CONCURRENT_TXS}. Potential stuck transactions.`)
  }
}

function deriveLocalFutureTimestamp(currentCycleRecord: {start: number; duration: number}): number {
  const cycleEndTimestamp = currentCycleRecord.start * 1000 + currentCycleRecord.duration * 1000
  console.log(`  Cycle end timestamp: ${new Date(cycleEndTimestamp).toISOString()} (${cycleEndTimestamp}) (cycle start: ${currentCycleRecord.start}, duration: ${currentCycleRecord.duration}))`)
  let futureTimestamp = cycleEndTimestamp + LIBERDUS_TIMESTAMP_MIN_FUTURE_MS
  console.log(`  Derived future timestamp: ${new Date(futureTimestamp).toISOString()} (${futureTimestamp})`)
  const currentTimestamp = Date.now()
  console.log(`  Current timestamp: ${new Date(currentTimestamp).toISOString()} (${currentTimestamp})`)
  while (futureTimestamp < currentTimestamp) {
    futureTimestamp += LIBERDUS_TIMESTAMP_MIN_FUTURE_MS
  }
  console.log(`  Final future timestamp: ${new Date(futureTimestamp).toISOString()} (${futureTimestamp})`)
  return futureTimestamp
}

async function getLiberdusReceipt(txId: string, maxRetries = 30): Promise<any> {
  const url = proxyServerHost + '/transaction/' + txId
  let count = 0
  let response: AxiosResponse | null = null
  while (count < maxRetries) {
    // try up to <maxRetries> times/seconds
    try {
      response = await axios.get(url)
      if (response && response.status === 200) {
        if (
          response.data &&
          response.data.transaction &&
          response.data.transaction.success !== undefined
        ) {
          break // Exit loop if we got a valid response
        }
      }
    } catch (e) {
      console.warn(`[getLiberdusReceipt] Attempt ${count + 1}/${maxRetries} failed for ${txId}:`, e instanceof Error ? e.message : e)
    }
    count++
    await sleep(1000)
  }
  if (!response) return null
  return response.data?.transaction ?? null
}

async function getLiberdusAccountBalance(address: string): Promise<string | null> {
  const url = proxyServerHost + '/account/' + address
  let count = 0
  let response: AxiosResponse | null = null
  let balance: string | null = null
  while (count < 10) {
    try {
      response = await axios.get(url)
      if (response && response.status === 200) {
        const rawValue = response.data.account?.data?.balance?.value
        if (rawValue == null) break
        balance = ethersUtils.formatEther('0x' + rawValue)
        break
      }
    } catch (e) {
      console.warn(`[getLiberdusAccountBalance] Attempt ${count + 1}/10 failed for ${address}:`, e instanceof Error ? e.message : e)
    }
    count++
    await sleep(1000)
  }
  if (!response || response.data == null || response.data.account == null) return null
  return balance
}

async function checkLiberdusAccountExists(shardusAddress: string): Promise<'exists' | 'not-found' | 'error'> {
  const url = proxyServerHost + '/account/' + shardusAddress
  const maxAttempts = 3
  let lastResult: 'not-found' | 'error' = 'error'
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.get(url, { timeout: 2000 })
      if (response.status === 200) {
        if (response.data?.account != null) return 'exists'
        lastResult = 'not-found'
      } else {
        lastResult = 'error'
      }
    } catch (e) {
      console.warn(`[checkLiberdusAccountExists] Attempt ${attempt}/${maxAttempts} failed for ${shardusAddress}:`, e instanceof Error ? e.message : e)
      lastResult = 'error'
    }
  }
  return lastResult
}

async function getLatestCycleRecord(): Promise<any> {
  const url = collectorHost + '/api/cycleinfo?count=1'
  const response = await axios.get(url)
  const {success, cycles} = response.data
  if (success && Array.isArray(cycles) && cycles.length > 0) return cycles[0].cycleRecord ?? null
  return null
}

function calculateChatId(from: string, to: string): string {
  return crypto.hash([from, to].sort((a, b) => a.localeCompare(b)).join(''))
}

async function main(): Promise<void> {
  console.log('Signing backend: BNB TSS')
  if (useDefaultSlotPath) {
    console.warn('No party index provided. Defaulting to slot-1 runtime semantics for observer/db and default-slot vault lookup.')
  }

  if (!operationFlag) {
    console.log('\nUsage: ts-node scripts/tss-party.ts [party_index]')
    console.log('\nStart the party with existing native TSS state.')
    console.log('')
  }

  if (operationFlag) {
    console.error(`Unsupported operation flag: ${operationFlag}`)
    console.error('Use the native helpers instead:')
    console.error('  npm run tss-init -- --party <idx> --chain-id <id>')
    console.error('  npm run tss-keygen -- --party <idx> --chain-id <id>')
    console.error('  npm run tss-verify -- --party <idx> --chain-id <id>')
    console.error('Start the signer with no operation flag.')
    process.exit(1)
  }

  try {
    console.log(`Validating BNB TSS vaults for party ${ourParty.idx}...`)
    await validateBnbTssSetup()
    console.log('BNB TSS vaults are ready')
  } catch (e) {
    console.error('Failed to validate BNB TSS setup:', e)
    await sleep(200) // Small delay before exiting to show up the error in logs
    process.exit(1)
  }

  // Initialize local DB (shared with the paired observer process)
  try {
    TransactionDB.initializeTransactionsDatabase(dbPath)
    console.log(`[tss-party] Local DB initialized at ${dbPath}`)
  } catch (e) {
    console.error('[tss-party] Failed to initialize local DB:', e)
    process.exit(1)
  }

  // Initialize nonce manager for each effective chain's TSS sender.
  for (const chainId of getEffectiveChainIds(chainConfigs)) {
    const config = getChainConfigById(chainConfigs, chainId)!

    try {
      await initNonceManager(chainId, config.tssSenderAddress!)
    } catch (e) {
      console.warn(`[nonce-manager] Failed to initialize for chain ${chainId}:`, e)
    }
  }
  await logStartupSignerBalances()

  await fetchStartupBridgeState()

  // Wait for the paired observer process to complete its initial sync
  console.log(`[tss-party] Waiting for observer at ${observerUrl} to become ready...`)
  await (async () => {
    const POLL_INTERVAL_MS = 3000
    while (true) {
      try {
        const res = await axios.get(`${observerUrl}/status`, { timeout: 5000 })
        if (res.data?.syncReady === true) {
          console.log('[tss-party] Observer is ready (syncReady=true)')
          return
        }
        console.log('[tss-party] Observer not ready yet (syncReady=false), retrying...')
      } catch {
        console.log(`[tss-party] Observer unreachable, retrying in ${POLL_INTERVAL_MS}ms...`)
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
  })()

  async function processTransaction(validTx: any): Promise<void> {
    const {txId} = validTx
    const startTime = Date.now()

    // Check if this transaction was already completed to avoid duplicate processing
    if (txQueueMap.get(txId)?.status === 'completed') {
      console.log(`⏩ Transaction ${txId} was recently completed, skipping duplicate processing`)
      txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
      pendingTxQueueRemovalSet.add(txId)
      processingTransactionIds.delete(txId)
      return
    }

    // Verify with the local DB that this tx hasn't already been completed
    const preProcess = reconcileTxStatusWithLocalDB(txId, 'pre-process')
    if (preProcess != null) {
      pendingTxQueueRemovalSet.add(txId)
      const tssSender = validTx.type === 'vaultBridge'
        ? chainConfigs.secondaryChainConfig!.tssSenderAddress!
        : getChainConfigById(chainConfigs, validTx.chainId)!.tssSenderAddress!
      if (preProcess === 'completed') {
        syncLocalNonceFromDB(validTx.type, validTx.chainId, tssSender)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
      } else if (preProcess === 'failed') {
        syncLocalNonceFromDB(validTx.type, validTx.chainId, tssSender)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        appendToFailedTxsLogs(validTx, 'already failed in local DB at pre-process')
      } else if (preProcess === 'reverted') {
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'reverted' })
      }
      processingTransactionIds.delete(txId)
      return
    }

    try {
      let processPromise: Promise<ProcessOutcome>
      if (validTx.type === 'coinToToken') {
        processPromise = processCoinToToken(
          validTx.from,
          validTx.value as ethers.BigNumber,
          validTx.txId,
          validTx.chainId,
          validTx.txTimestamp,
        )
      } else if (validTx.type === 'tokenToCoin') {
        console.log('Processing token to coin transaction', validTx)
        processPromise = processTokenToCoin(
          validTx.from,
          validTx.value as ethers.BigNumber,
          validTx.txId,
          validTx.chainId,
          validTx.txTimestamp,
        )
      } else if (validTx.type === 'vaultBridge') {
        console.log('Processing vault bridge (EVM-to-EVM) transaction', validTx)
        processPromise = processVaultBridge(
          validTx.from,
          validTx.value as ethers.BigNumber,
          validTx.txId,
          validTx.chainId,
          chainConfigs.secondaryChainConfig!.chainId,
          validTx.txTimestamp,
        )
      } else {
        throw new Error(`Unsupported transaction type: ${validTx.type}`)
      }
      const failPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new Error(TX_PROCESSING_TIMEOUT_ERROR))
        }, TX_PROCESSING_TIMEOUT_MS)
      })
      // wait for either the transaction to be processed or the timeout
      const outcome = await Promise.race([processPromise, failPromise]) as ProcessOutcome
      if (outcome === 'completed') {
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
        pendingTxQueueRemovalSet.add(txId)
        console.log('Transaction processed successfully:', validTx)
      } else if (outcome === 'failed') {
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        pendingTxQueueRemovalSet.add(txId)
        appendToFailedTxsLogs(validTx, 'failed on-chain')
        console.warn(`Transaction ${validTx.txId} was executed but failed on-chain`)
      } else if (outcome === 'reverted') {
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'reverted' })
        pendingTxQueueRemovalSet.add(txId)
        console.log(`Transaction ${validTx.txId} reverted — amount exceeded local limit, refunded to sender`)
      } else if (outcome === 'incompleted') {
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'incompleted' })
        console.warn(`Transaction ${validTx.txId} reported incompleted outcome during processing`)
      } else if (outcome === 'skipped_db_completed') {
        console.log(`Transaction ${validTx.txId} was already completed in local DB during reconcile, skipping`)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
        pendingTxQueueRemovalSet.add(txId)
        const tssSender = validTx.type === 'vaultBridge'
          ? chainConfigs.secondaryChainConfig!.tssSenderAddress!
          : getChainConfigById(chainConfigs, validTx.chainId)!.tssSenderAddress!
        syncLocalNonceFromDB(validTx.type, validTx.chainId, tssSender)
      } else if (outcome === 'skipped_db_failed') {
        console.log(`Transaction ${validTx.txId} was already failed in local DB during reconcile, skipping`)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        pendingTxQueueRemovalSet.add(txId)
        appendToFailedTxsLogs(validTx, 'already failed in local DB during reconcile')
        const tssSender = validTx.type === 'vaultBridge'
          ? chainConfigs.secondaryChainConfig!.tssSenderAddress!
          : getChainConfigById(chainConfigs, validTx.chainId)!.tssSenderAddress!
        syncLocalNonceFromDB(validTx.type, validTx.chainId, tssSender)
      } else if (outcome === 'skipped_db_reverted') {
        console.log(`Transaction ${validTx.txId} was already reverted in local DB during reconcile, skipping`)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'reverted' })
        pendingTxQueueRemovalSet.add(txId)
      }

      // Check memory usage after successful transaction
      checkPostTransactionMemory(validTx.txId, 'transaction-processing')
      
      // Force cleanup after successful transaction processing
      if (global.gc) {
        tryGC()
      }
    } catch (error: any) {
      if (error.message === bnbTss.SIGNING_TIMEOUT_ERROR || error.message === TX_PROCESSING_TIMEOUT_ERROR) {
        const isSigningTimeout = error.message === bnbTss.SIGNING_TIMEOUT_ERROR
        const timeoutReason = isSigningTimeout ? bnbTss.SIGNING_TIMEOUT_ERROR : TX_PROCESSING_TIMEOUT_ERROR

        if (isSigningTimeout) {
          console.log('Transaction signing timed out', validTx.txId)
        } else {
          console.warn('Transaction processing timed out', validTx.txId)
        }

        const finalStatus = checkTxStatusFromLocalDB(validTx.txId)
        if (finalStatus === TransactionStatus.COMPLETED) {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
          pendingTxQueueRemovalSet.add(txId)
          // Another party submitted this tx — nonce was consumed, advance local tracker
          if (validTx.type !== 'tokenToCoin') {
            const nonceCacheChainId = validTx.type === 'vaultBridge'
              ? chainConfigs.secondaryChainConfig!.chainId
              : validTx.chainId
            const nonceTssSender = validTx.type === 'vaultBridge'
              ? chainConfigs.secondaryChainConfig!.tssSenderAddress!
              : getChainConfigById(chainConfigs, validTx.chainId)!.tssSenderAddress!
            incrementLocalNonce(nonceCacheChainId, nonceTssSender)
          }
          console.log(`[${timeoutReason}] ${validTx.txId} already COMPLETED in local DB`)
        } else if (finalStatus === TransactionStatus.REVERTED) {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'reverted' })
          pendingTxQueueRemovalSet.add(txId)
          console.log(`[${timeoutReason}] ${validTx.txId} already REVERTED in local DB`)
        } else {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
          appendToFailedTxsLogs(validTx, timeoutReason)
          console.warn(`[${timeoutReason}] ${validTx.txId} not completed in local DB`)
        }
        checkPostTransactionMemory(validTx.txId, timeoutReason)
        if (global.gc) {
          tryGC()
        }
      } else {
        // Handle other errors
        console.error('❌ Error processing transaction:', error)
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        appendToFailedTxsLogs(validTx, error.message ?? 'unknown')
        
        // Force cleanup after any error
        if (global.gc) {
          tryGC()
        }
      }
    } finally {
      // Remove from processing set when done (success or failure)
      const endTime = Date.now()
      console.log(`Time taken for processTransaction: ${endTime - startTime} ms`)
      processingTransactionIds.delete(validTx.txId)
    }
  }

  const handleTransactionQueue = () => {
    if (verboseLogs) console.log('Running handleTransactionQueue', new Date().toISOString())

    // Drain the deferred removal set — remove entries that async
    // processing marked for removal. Backward iteration avoids index corruption.
    if (pendingTxQueueRemovalSet.size > 0) {
      for (let i = pendingTxQueue.length - 1; i >= 0; i--) {
        if (pendingTxQueueRemovalSet.has(pendingTxQueue[i].txId)) {
          pendingTxQueue.splice(i, 1)
        }
      }
      pendingTxQueueRemovalSet.clear()
    }

    // Process new transactions while we have available slots
    for (const validTx of pendingTxQueue) {
      if (processingTransactionIds.size >= MAX_CONCURRENT_TXS) break
      if (processingTransactionIds.has(validTx.txId)) continue

      // Update transaction status to processing
      txQueueMap.set(validTx.txId, {
        txTimestamp: validTx.txTimestamp!,
        status: 'processing',
      })

      // Store full txData in processingTransactionIds for crash recovery
      processingTransactionIds.set(validTx.txId, validTx)

      // PROCESSING is tracked locally in txQueueMap / local DB for crash recovery visibility.
      // sendTxStatusToCoordinator(validTx.txId, TransactionStatus.PROCESSING, '')

      // Start processing the transaction (fire and forget)
      processTransaction(validTx).catch((error) => {
        console.error(`Unexpected error in processTransaction for ${validTx.txId}:`, error)
        // Ensure cleanup happens even if there's an unexpected error
        processingTransactionIds.delete(validTx.txId)
      })
    }
    if (processingTransactionIds.size)
      console.log(
        `Currently processing ${processingTransactionIds.size} transactions, ${pendingTxQueue.length} in queue`,
      )
  }

  /**
   * Drift-resistant scheduler that synchronizes function execution across multiple servers
   *
   * This scheduler solves several problems:
   * 1. Timer Drift: setInterval accumulates small timing errors over time
   * 2. Server Synchronization: Multiple servers starting at different times stay synchronized
   * 3. Clock Alignment: All executions happen at exact second boundaries (e.g., 0s, 3s, 6s, 9s)
   *
   * How it works:
   * - Calculates the next exact second boundary based on the interval
   * - Uses setTimeout with precise delays to hit those boundaries
   * - Self-corrects on each execution by recalculating the next target time
   * - Always targets 0 milliseconds (.000Z) to prevent drift
   *
   * @param {Function} fn - Function to execute on schedule
   * @param {number} intervalMS - Interval in milliseconds (e.g., 3000 for 3 seconds)
   */

  startDriftResistantScheduler(handleTransactionQueue, txQueueProcessingInterval)
  // Add memory management and monitoring schedulers
  startDriftResistantScheduler(cleanupOldTransactions, 10 * 60 * 1000) // Every 10 minutes
  startDriftResistantScheduler(logMemoryUsage, 5 * 60 * 1000) // Every 5 minutes
  startDriftResistantScheduler(cleanupStuckTransactions, 2 * 60 * 1000) // Every 2 minutes

  // Poll local DB for new pending transactions
  startDriftResistantScheduler(pollPendingTransactionsFromLocalDB, TX_POLL_INTERVAL)
}

main()
  .then(() => {
  })
  .catch((error) => {
    console.error('Fatal error in main:', error)
    process.exit(1)
  })
