import 'dotenv/config'
import {ethers} from 'ethers'
import * as fs from 'fs'
import {writeFile} from 'fs/promises'
import * as path from 'path'
import axios, {AxiosResponse} from 'axios'
import http from 'http'
import https from 'https'
import * as crypto from '@shardus/crypto-utils'
import * as readline from 'readline-sync'
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
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'reverted'
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

type ProcessOutcome = 'completed' | 'failed' | 'reverted' | 'skipped_db_completed' | 'skipped_db_failed' | 'skipped_db_reverted'

function txStatusLabel(status: TransactionStatus): string {
  switch (status) {
    case TransactionStatus.PENDING:    return 'PENDING'
    case TransactionStatus.PROCESSING: return 'PROCESSING'
    case TransactionStatus.COMPLETED:  return 'COMPLETED'
    case TransactionStatus.FAILED:     return 'FAILED'
    case TransactionStatus.REVERTED:   return 'REVERTED'
    default: return `UNKNOWN(${status})`
  }
}

const parsedIdx = process.argv[2]
const operationFlag = process.argv[3]

const verboseLogs = true

const serverStartTime = Date.now()

const params: ParamsConfig = paramsConfigRaw
const chainConfigs: ChainConfigs = chainConfigsRaw

let t = params.threshold
let n = params.parties

const BNB_SIGN_DISCOVERY_TIMEOUT_MS = 30 * 1000
const BNB_SIGN_DISCOVERY_TIMEOUT = `${BNB_SIGN_DISCOVERY_TIMEOUT_MS / 1000}s`
const BNB_SIGN_PROCESS_TIMEOUT_MS = BNB_SIGN_DISCOVERY_TIMEOUT_MS + 30 * 1000

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

const tssPartyIdx =
  parsedIdx == null ? readline.question('Enter the party index (1 to 5): ') : parsedIdx
const ourParty: PartyInfo = {idx: parseInt(tssPartyIdx)}

const observerUrl = `http://127.0.0.1:${8100 + ourParty.idx}`
const dbPath = path.resolve(process.cwd(), 'db', `transactions-${ourParty.idx}.sqlite`)

// In vault mode use [vaultChain, secondaryChainConfig]; in Liberdus mode use supportedChains
const chainsToInit: ChainConfig[] = getConfiguredChains(chainConfigs)
const chainRpcConfig = initializeChainRpcConfig(chainsToInit)

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
async function fetchBridgeState(chainId: number, fields: FetchBridgeStateFields = 'all'): Promise<void> {
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
      const maxAmountStr = chainState.maxBridgeInAmount.isZero()
        ? 'unlimited'
        : `${ethersUtils.formatEther(chainState.maxBridgeInAmount)} ETH`
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
      const maxAmountStr = chainState.maxBridgeInAmount.isZero()
        ? 'unlimited'
        : `${ethersUtils.formatEther(chainState.maxBridgeInAmount)} ETH`
      console.log(`Bridge maxBridgeInAmount fetched for ${chainState.config.name}: ${maxAmountStr}`)
    }
  } catch (error) {
    console.warn(`Failed to fetch bridge state for chain ${chainId}:`, error)
  }
}

async function waitForBridgeCooldown(chainState: ChainState, chainName: string): Promise<void> {
  if (chainState.bridgeInCooldown <= 0 || chainState.lastBridgeInTime <= 0) return
  const latestBlock = await chainRpcConfig.withChainHttpProvider(
    chainState.config.chainId,
    (provider) => provider.getBlock('latest'),
    { maxRetries: 3 },
  )
  const now = latestBlock.timestamp
  const cooldownEnd = chainState.lastBridgeInTime + chainState.bridgeInCooldown
  if (now < cooldownEnd) {
    const waitSec = cooldownEnd - now
    console.log(
      `Waiting ${waitSec}s for bridge-in cooldown on ${chainName}: ` +
      `lastBridgeInTime=${new Date(chainState.lastBridgeInTime * 1000).toISOString()}, ` +
      `cooldown=${chainState.bridgeInCooldown}s, ` +
      `cooldownEnd=${new Date(cooldownEnd * 1000).toISOString()}, ` +
      `chainNow=${new Date(now * 1000).toISOString()}`
    )
    await sleep(waitSec * 1000)
  }
}

function checkMaxBridgeAmount(
  chainState: ChainState,
  value: ethers.BigNumber,
): boolean {
  if (chainState.maxBridgeInAmount.isZero()) return true
  if (value.lte(chainState.maxBridgeInAmount)) return true
  return false
}

async function refreshBridgeStateOnRevert(reason: string | undefined, chainId: number): Promise<void> {
  if (!reason || (!reason.includes('Bridge-in cooldown not met') && !reason.includes('Amount exceeds bridge-in limit'))) return
  console.log(`Refreshing bridge state for chain ${chainId} due to revert: ${reason}`)
  await fetchBridgeState(chainId)
}

async function fetchStartupBridgeState(): Promise<void> {
  for (const [chainId] of chainStateByChainId.entries()) {
    if (!chainConfigs.enableLiberdusNetwork && chainId === chainConfigs.vaultChain!.chainId) continue
    console.log(`Fetching bridge state for chain ${chainId}`)
    await fetchBridgeState(chainId)
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
const txQueueProcessingInterval = 10000
const TX_POLL_INTERVAL = 10 * 1000 // 10s
const TX_PROCESSING_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes ( Including the bridgeInCooldown 1-minute)

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
      if (verboseLogs) {
        console.log(`🗑️ Removed ${entry.status} transaction ${txId} (age: ${Math.round(txAge / 60000)}min)`)
      }
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

function removeFromPendingTxQueue(txId: string): void {
  const idx = pendingTxQueue.findIndex(t => t.txId === txId)
  if (idx !== -1) pendingTxQueue.splice(idx, 1)
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
): void {
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
      if (verboseLogs) {
        console.log(`[updateTxStatus] Updated ${normalizedTxId} → status=${status}`)
      }
    } else if (result === 'duplicate') {
      console.log(`[updateTxStatus] Duplicate status update ignored for ${normalizedTxId}`)
    } else if (result === 'no_downgrade') {
      console.log(`[updateTxStatus] Status downgrade blocked for ${normalizedTxId} (attempted ${status})`)
    } else if (result === 'not_found') {
      console.error(`[updateTxStatus] Transaction ${normalizedTxId} not found in local DB`)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[updateTxStatus] Error updating status for ${txId}: ${errorMessage}`)
  }
}


async function pollPendingTransactionsFromLocalDB(): Promise<void> {
  console.log('Polling pending transactions from local DB...', new Date().toISOString())
  try {
    const dbTxs = TransactionDB.getTransactionsByPage(10, 0, { unprocessed: true })
    const transactions: Transaction[] = dbTxs
      .slice()
      .sort((a, b) => a.txTimestamp - b.txTimestamp)
    if (transactions.length === 0) return

    console.log(`[poll] Found ${transactions.length} pending transactions`)

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
      if (tx.status === TransactionStatus.COMPLETED || tx.status === TransactionStatus.FAILED || tx.status === TransactionStatus.REVERTED) {
        console.log(`[poll] Skipping tx ${tx.txId} — DB reports ${txStatusLabel(tx.status)}`)
        continue
      }

      const existingEntry = txQueueMap.get(tx.txId)
      if (existingEntry) {
        // If we previously marked it failed/reverted but the DB still shows it pending, retry
        if ((existingEntry.status === 'failed' || existingEntry.status === 'reverted') && !pendingTxQueue.some(t => t.txId === tx.txId)) {
          console.log(`[poll] Retrying tx ${tx.txId} — previously ${existingEntry.status} locally but DB reports pending`)
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
        if (existingEntry.status === 'failed' || existingEntry.status === 'reverted') {
          existingEntry.status = 'pending'
        }
      } else {
        txQueueMap.set(tx.txId, { txTimestamp: tx.txTimestamp, status: 'pending' })
      }
      if (verboseLogs) {
        const chainName = getChainConfigById(chainConfigs, tx.chainId)?.name || 'Unknown'
        console.log(`[poll] ${existingEntry ? 'Re-queued' : 'Added'} ${bridgeType} tx ${tx.txId} from local DB (${chainName})`)
      }
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
    const tx = TransactionDB.getTransactionById(txId)
    if (!tx) return null
    return tx.status
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`[checkTxStatus] DB read failed for ${txId}: ${errorMessage}`)
  }
}

async function refreshLastBridgeInTime(
  txId: string,
  txType: TransactionQueueItem['type'],
  chainId: number,
): Promise<void> {
  try {
    if (txType === 'coinToToken') {
      await fetchBridgeState(chainId, 'lastBridgeInTime')
    } else if (txType === 'vaultBridge' && chainConfigs.secondaryChainConfig?.chainId != null) {
      await fetchBridgeState(chainConfigs.secondaryChainConfig.chainId, 'lastBridgeInTime')
    }
  } catch (error) {
    console.warn(`[bridge-state] Failed to refresh lastBridgeInTime for tx ${txId}`, error)
  }
}

// ---------------------------------------------------------------------------
// Nonce manager — tracks the expected next EVM nonce per chain per sender.
// Initialized from on-chain state at startup, incremented locally on
// success/revert (nonce consumed), NOT incremented on send failure.
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

// ---------------------------------------------------------------------------
// In-memory signed tx cache — for EVM rebroadcast without re-signing.
// Keyed by normalized txId. Cleared on completion, revert, or process restart.
// ---------------------------------------------------------------------------

const signedTxCache: Map<string, { signedTx: string; txHash: string; nonce: number }> = new Map()

// ---------------------------------------------------------------------------
function reconcileTxStatusWithLocalDB(
  txId: string,
  context: 'pre-process' | 'pre-sign',
): null | 'completed' | 'failed' | 'reverted' {
  try {
    const status = checkTxStatusFromLocalDB(txId)
    if (status == null || status === TransactionStatus.PENDING || status === TransactionStatus.PROCESSING) {
      return null
    }
    const statusLabel = status === TransactionStatus.COMPLETED ? 'completed' :
      status === TransactionStatus.REVERTED ? 'reverted' : 'failed'
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

// Syncs the local nonce to maxDbNonce+1 if any finalized (COMPLETED/REVERTED) tx for this sender
// is ahead. chainId is the source chain as stored in the DB. For vaultBridge the nonce manager
// lives on the destination chain, so nonceCacheChainId is derived from txType.
function syncLocalNonceFromDB(txType: TransactionQueueItem['type'], chainId: number, tssSender: string): void {
  const maxDbNonce = TransactionDB.getMaxNonceForSender(chainId, tssSender)
  if (maxDbNonce == null) return
  const nonceCacheChainId = txType === 'vaultBridge' ? chainConfigs.secondaryChainConfig!.chainId : chainId
  const currentLocal = getLocalNonce(nonceCacheChainId, tssSender)
  if (currentLocal == null || maxDbNonce + 1 > currentLocal) {
    setLocalNonce(nonceCacheChainId, tssSender, maxDbNonce + 1)
    console.log(`[nonce-manager] Synced nonce for chain ${nonceCacheChainId} to ${maxDbNonce + 1} (dbChain=${chainId}, maxDbNonce=${maxDbNonce})`)
  }
}


// ---------------------------------------------------------------------------
// getTransactionHashByNonce — binary-searches block history to find the txHash
// for a given sender address + nonce. Falls back to null if not found.
// ---------------------------------------------------------------------------

async function getTransactionHashByNonce(
  chainId: number,
  address: string,
  targetNonce: number,
): Promise<string | null> {
  // Binary search: find the first block where getTransactionCount(address) > targetNonce
  const currentBlock = await chainRpcConfig.withChainHttpProvider(
    chainId, (p) => p.getBlockNumber(), { maxRetries: 3 })

  let low = 0
  let high = currentBlock
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const nonceAtMid = await chainRpcConfig.withChainHttpProvider(
      chainId, (p) => p.getTransactionCount(address, mid), { maxRetries: 3 })
    if (nonceAtMid <= targetNonce) {
      low = mid + 1
    } else {
      high = mid
    }
  }

  // `low` is the block that first included the tx consuming `targetNonce`
  const block = await chainRpcConfig.withChainHttpProvider(
    chainId, (p) => p.getBlockWithTransactions(low), { maxRetries: 3 })
  if (!block) return null

  for (const tx of block.transactions) {
    if (tx.from?.toLowerCase() === address.toLowerCase() && tx.nonce === targetNonce) {
      return tx.hash
    }
  }
  return null
}

// reconcileNonceDrift — called when the chain nonce is ahead of the local nonce tracker,
// meaning some transactions were mined without our knowledge (e.g. after a crash/restart or
// a missed receipt). Scans the drift range [fromNonce, toNonce):
//   1. Checks the local DB for any known txs that used nonces in the range.
//   2. For any nonce not accounted for in the DB (gap nonces), binary-searches the chain to
//      find the txHash, fetches its receipt, extracts the txId from the BridgedIn event (success)
//      or calldata (revert), and updates the DB accordingly.
//   3. If the chain has advanced further than toNonce during reconciliation, recurses to cover
//      the wider gap.
// Returns { latestDbNonce, receiptId } where receiptId is non-null if currentTxId was found
// to have been completed during this reconciliation pass.
// ---------------------------------------------------------------------------

async function reconcileNonceDrift(
  currentTxId: string,
  chainId: number,
  txType: TransactionQueueItem['type'],
  tssSender: string,
  fromNonce: number,
  toNonce: number,
): Promise<{ latestDbNonce: number; receiptId: string | null } | null> {
  // For vaultBridge, on-chain RPC calls target the destination chain; DB queries use the source chainId
  const rpcChainId = txType === 'vaultBridge' ? chainConfigs.secondaryChainConfig!.chainId : chainId
  console.log(`[nonce-drift] Reconciling drift for chain=${chainId}, rpcChain=${rpcChainId}: from=${fromNonce}, to=${toNonce}`)

  // Find txs in our DB that used nonces in the drift range
  let driftTxs = TransactionDB.getTransactionsByNonceRange(chainId, tssSender, fromNonce, toNonce)

  console.log(`[nonce-drift] Found ${driftTxs.length} txs in drift range for chain=${chainId}, rpcChain=${rpcChainId}: from=${fromNonce}, to=${toNonce}`)

  let latestDbNonce = fromNonce - 1  // gap scan starts at latestDbNonce + 1 = fromNonce
  let receiptId = ''

  for (const tx of driftTxs) {
    // Track receiptId if this is the tx we're currently processing
    if (tx.receiptId && tx.txId === currentTxId) {
      receiptId = tx.receiptId
    }
    if (tx.status === TransactionStatus.COMPLETED && tx.nonce != null) {
      if (latestDbNonce < tx.nonce) {
        latestDbNonce = tx.nonce
      }
    }

    // Check execution history entries for consumed nonces (COMPLETED or REVERTED = nonce used)
    const history: Record<string, ExecutionHistoryEntry> = JSON.parse(tx.executionHistory || '{}')
    for (const [nonceKey, entry] of Object.entries(history)) {
      if (entry.status === TransactionStatus.REVERTED || entry.status === TransactionStatus.COMPLETED) {
        if (latestDbNonce < Number(nonceKey)) {
          latestDbNonce = Number(nonceKey)
        }
      }
    }
  }

  if (latestDbNonce + 1 < toNonce) {
    // There are nonces in (latestDbNonce, toNonce) not accounted for in DB.
    // Binary-search on-chain to find the txHash for each missing nonce, then
    // fetch its receipt. These may belong to txs processed by another party or
    // submitted outside our DB.
    for (let nonce = latestDbNonce + 1; nonce < toNonce; nonce++) {
      try {
        const txHash = await getTransactionHashByNonce(rpcChainId, tssSender, nonce)
        if (!txHash) {
          console.warn(`[nonce-drift] Could not find tx for nonce=${nonce} on chain ${rpcChainId}`)
          continue
        }
        const [receipt, onChainTx] = await Promise.all([
          getChainTransactionReceipt(rpcChainId, txHash),
          chainRpcConfig.withChainHttpProvider(
            rpcChainId, (p) => p.getTransaction(txHash), { maxRetries: 3 }),
        ])
        if (receipt) {
          latestDbNonce = nonce  // nonce was consumed regardless of status
          console.log(`[nonce-drift] Gap nonce=${nonce} status=${receipt.status} txHash=${txHash} on chain ${rpcChainId}`)

          // Extract txId: from BridgedIn event logs on success, or from calldata on revert
          let parsedTxId: string | null = null

          if (receipt.status === 1) {
            for (const log of receipt.logs) {
              try {
                const parsed = BRIDGE_CONTRACT_IFACE.parseLog(log)
                if (parsed.name === 'BridgedIn') {
                  parsedTxId = normalizeTxId(parsed.args.txId as string)
                  break
                }
              } catch {
                // Not a BridgedIn log — skip
              }
            }
          } else if (receipt.status === 0 && onChainTx?.data) {
            // No event on revert — decode txId from calldata instead
            try {
              const decoded = BRIDGE_CONTRACT_IFACE.decodeFunctionData('bridgeIn', onChainTx.data)
              parsedTxId = normalizeTxId(decoded.txId as string)
            } catch {
              console.warn(`[nonce-drift] Gap nonce=${nonce} reverted but failed to decode calldata`)
            }
          }

          if (parsedTxId) {
            const newStatus = receipt.status === 1 ? TransactionStatus.COMPLETED : TransactionStatus.REVERTED
            console.log(`[nonce-drift] Gap nonce=${nonce} → txId=${parsedTxId} ${newStatus === TransactionStatus.COMPLETED ? 'COMPLETED' : 'REVERTED'} on chain ${rpcChainId}`)
            updateTxStatusInLocalDB(parsedTxId, newStatus, txHash, tssSender, nonce, '')
            if (receipt.status === 1 && parsedTxId === normalizeTxId(currentTxId)) {
              receiptId = txHash
            }
          } else {
            console.warn(`[nonce-drift] Gap nonce=${nonce} could not determine txId for txHash=${txHash}`)
          }
        }
      } catch (err) {
        console.warn(`[nonce-drift] Error fetching tx for nonce=${nonce}: ${err instanceof Error ? err.message : err}`)
      }
    }

    // Check if chain has advanced further than toNonce — recurse to cover the wider gap
    const latestChainNonce = await getLatestChainNonce(rpcChainId, tssSender)
    if (latestChainNonce < latestDbNonce) {
      // This shouldn't happen
      console.error(`[nonce-drift] DB nonce ${latestDbNonce} > chain nonce ${latestChainNonce} for chain ${rpcChainId}`)
    } else if (latestChainNonce > toNonce) {
      const recurseResult = await reconcileNonceDrift(currentTxId, chainId, txType, tssSender, latestDbNonce + 1, latestChainNonce)
      if (recurseResult) {
        latestDbNonce = recurseResult.latestDbNonce
        if (recurseResult.receiptId) receiptId = recurseResult.receiptId
      }
    }
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
    partyIdx: ourParty.idx,
    chainIds,
    expectedAddressesByChainId,
  })
  console.log(`Validated BNB TSS vaults for party ${ourParty.idx}:`)
  for (const result of results) {
    console.log(
      `  chain ${result.chainId}: ${result.ethereum_address} (${result.home})`,
    )
  }
}

function signDigestWithBnbTss(chainId: number, digest: string, channelId: string, channelPassword: string) {
  console.log('Signing digest with BNB TSS', chainId, digest, channelId)
  return bnbTss.signDigest({
    partyIdx: ourParty.idx,
    chainId,
    digest,
    channelId,
    channelPassword,
    signDiscoveryTimeout: BNB_SIGN_DISCOVERY_TIMEOUT,
    timeoutMs: BNB_SIGN_PROCESS_TIMEOUT_MS,
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
  
  if (verboseLogs) {
    console.log('Ethereum transaction signed successfully!', {
      ...tx,
      sign: {
        owner: computeAddress,
        sig: ethersUtils.joinSignature(signature),
      },
    })
  }
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
  
  if (verboseLogs) {
    console.log('Liberdus transaction signed successfully!', signedTx)
  }
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
      {maxRetries: 1},
    )
    const receipt = await txResponse.wait()
    console.log('Receipt', txHash, receipt)
    if (receipt.status !== 1) throw new Error('Transaction failed')
    // const balance = await providerToUse.getBalance(receipt.to!);
    // const senderBalance = await providerToUse.getBalance(receipt.from);
    // console.log("Recipient address balance:", ethers.utils.formatEther(balance));
    // console.log("Sender address balance:", ethers.utils.formatEther(senderBalance));
    if (verboseLogs) {
      console.log('BridgeIn transaction sent successfully!', receipt.transactionHash)
    }
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
    if (verboseLogs) {
      console.log('BridgeOut transaction sent successfully!', txId)
    }
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
): Promise<ProcessOutcome> {
  value = ethers.BigNumber.from(value)
  console.log('Processing coin to token transaction', {
    to,
    value: value.toString(),
    targetChainId,
  })

  const chainState = chainStateByChainId.get(targetChainId)
  if (!chainState) {
    console.error(`[ProcessCoinToToken] Chain provider not found for chainId ${targetChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `chain provider not found for chainId ${targetChainId}`)
    return 'failed'
  }

  const targetChainName = chainState.config.name
  const tssSender = chainState.config.tssSenderAddress
  const normalizedTxId = normalizeTxId(txId)
  let senderNonce = getLocalNonce(targetChainId, tssSender)
  console.log(`Processing transaction on ${targetChainName}`)

  if (!checkMaxBridgeAmount(chainState, value)) {
    const reason = `Amount ${ethersUtils.formatEther(value)} exceeds bridge-in limit ${ethersUtils.formatEther(chainState.maxBridgeInAmount)} on ${targetChainName}`
    console.error(reason)
    updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, '', tssSender, senderNonce as number, reason)
    // If 'failed' status is sent, remove it from the queue ( so that we don't process it again )
    removeFromPendingTxQueue(txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed on ${targetChainName}`)
    return 'failed'
  }
  await waitForBridgeCooldown(chainState, targetChainName)

  // Fetch chain nonce and compare with local nonce manager
  const chainNonce = await getLatestChainNonce(targetChainId, tssSender)
  let localNonce = getLocalNonce(targetChainId, tssSender)

  if (localNonce != null && chainNonce > localNonce) {
    // Nonce drift — some txs with nonces in [localNonce, chainNonce) were mined without our knowledge
    console.warn(`[nonce-manager] Drift on ${targetChainName}: local=${localNonce}, chain=${chainNonce}`)
    const driftResult = await reconcileNonceDrift(txId, targetChainId, 'coinToToken', tssSender, localNonce, chainNonce)
    setLocalNonce(targetChainId, tssSender, chainNonce)
    localNonce = getLocalNonce(targetChainId, tssSender)
    if (driftResult?.receiptId) {
      console.log(`[double-exec-guard] ${txId} was completed during nonce drift reconciliation`)
      await refreshLastBridgeInTime(txId, 'coinToToken', targetChainId)
      return 'completed'
    }
  } else if (localNonce != null && localNonce > chainNonce) {
    // This shouldn't happen — local is ahead of chain
    console.warn(`[nonce-manager] Local nonce ahead of chain on ${targetChainName}: local=${localNonce}, chain=${chainNonce}`)
    // Abort this transaction to avoid potential double execution
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `local nonce ahead of chain on ${targetChainName}`)
    return 'failed'
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
    try {
      await retryOperation(() => injectEthereumTx(targetChainId, cached.txHash, cached.signedTx), {
        txId: cached.txHash,
        maxRetries: 3,
      })
      const cachedReceipt = await getChainTransactionReceipt(targetChainId, cached.txHash)
      if (cachedReceipt?.status === 1) {
        const block = await chainRpcConfig.withChainHttpProvider(
          targetChainId, (provider) => provider.getBlock(cachedReceipt.blockNumber), { maxRetries: 3 })
        chainState.lastBridgeInTime = block.timestamp
        updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, cached.txHash, tssSender, senderNonce)
        signedTxCache.delete(normalizedTxId)
        incrementLocalNonce(targetChainId, tssSender)
        return 'completed'
      } else if (cachedReceipt?.status === 0) {
        console.log(`[nonce-guard] Cached tx reverted on ${targetChainName}: ${cached.txHash}`)
        updateTxStatusInLocalDB(txId, TransactionStatus.REVERTED, cached.txHash, tssSender, senderNonce)
        signedTxCache.delete(normalizedTxId)
        incrementLocalNonce(targetChainId, tssSender)
        return 'reverted'
      }
    } catch (e) {
      console.warn(`[nonce-guard] Rebroadcast failed, will re-sign: ${e instanceof Error ? e.message : e}`)
    }
  } else if (cached) {
    // Nonce changed — cached tx is stale
    signedTxCache.delete(normalizedTxId)
  }

  let currentGasPrice = await chainRpcConfig.withChainHttpProvider(
    targetChainId,
    (provider) => provider.getGasPrice(),
    { maxRetries: 3 },
  )

  // Apply gas price logic based on chain configuration
  for (const tierGwei of chainState.gasPriceTiersBN) {
    if (currentGasPrice.lt(tierGwei)) {
      currentGasPrice = tierGwei
      break
    }
  }

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
    return 'failed'
  }

  // Cache signed tx + broadcast
  const txHash = ethersUtils.keccak256(signedTx as string)
  signedTxCache.set(normalizedTxId, { signedTx: signedTx as string, txHash, nonce: senderNonce })
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
    await refreshBridgeStateOnRevert(reason, targetChainId)
  }

  let receipt = await getChainTransactionReceipt(targetChainId, txHash)
  if (!receipt) {
    // Tx may have been broadcast but not yet mined — retry once after a short delay
    await delay_ms(3000)
    receipt = await getChainTransactionReceipt(targetChainId, txHash)
  }
  if (receipt) {
    if (receipt.status === 1) {
      console.log(
        `Transaction is successful - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      )
      const block = await chainRpcConfig.withChainHttpProvider(
        targetChainId,
        (provider) => provider.getBlock(receipt.blockNumber),
        { maxRetries: 3 },
      )
      chainState.lastBridgeInTime = block.timestamp
      updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, txHash, tssSender, senderNonce, '')
      signedTxCache.delete(normalizedTxId)
      incrementLocalNonce(targetChainId, tssSender)
      return 'completed'
    } else {
      console.log(
        `Transaction failed in execution - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, `failed in execution on ${targetChainName}`)
      updateTxStatusInLocalDB(txId, TransactionStatus.REVERTED, txHash, tssSender, senderNonce, '')
      signedTxCache.delete(normalizedTxId)
      incrementLocalNonce(targetChainId, tssSender)  // nonce consumed even on revert
      return 'reverted'
    }
  } else {
    console.log(
      `Transaction failed - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      res.reason,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send failed on ${targetChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, txHash, tssSender, senderNonce, res.reason as string)
    // If 'failed' status is sent, remove it from the queue ( so that we don't process it again )
    removeFromPendingTxQueue(txId)
    // Don't increment nonce — tx may not have been broadcast/mined
    // signedTxCache is NOT cleared — we may want to rebroadcast on next attempt
    return 'failed'
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
    return 'failed'
  }

  const destChainState = chainStateByChainId.get(destinationChainId)
  if (!destChainState) {
    console.error(`Destination chain provider not found for chainId ${destinationChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `destination chain provider not found for chainId ${destinationChainId}`)
    return 'failed'
  }

  const sourceChainName = sourceChainState.config.name
  const destChainName = destChainState.config.name
  const tssSender = destChainState.config.tssSenderAddress
  const normalizedTxId = normalizeTxId(txId)
  let senderNonce = getLocalNonce(destinationChainId, tssSender)

  console.log(`Processing vault bridge: ${sourceChainName} -> ${destChainName}`)

  if (!checkMaxBridgeAmount(destChainState, value)) {
    const reason = `Amount ${ethersUtils.formatEther(value)} exceeds bridge-in limit ${ethersUtils.formatEther(destChainState.maxBridgeInAmount)} on ${destChainName}`
    console.error(reason)
    updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, '', tssSender, senderNonce, reason)
    // If 'failed' status is sent, remove it from the queue ( so that we don't process it again )
    removeFromPendingTxQueue(txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed on ${destChainName}`)
    return 'failed'
  }
  await waitForBridgeCooldown(destChainState, destChainName)

  // Fetch chain nonce and compare with local nonce manager
  const chainNonce = await getLatestChainNonce(destinationChainId, tssSender)
  let localNonce = getLocalNonce(destinationChainId, tssSender)

  if (localNonce != null && chainNonce > localNonce) {
    // Nonce drift — some txs with nonces in [localNonce, chainNonce) were mined without our knowledge
    console.warn(`[nonce-manager] Drift on ${destChainName}: local=${localNonce}, chain=${chainNonce}`)
    // For vault bridge, sourceChainId has to be passed to reconcileNonceDrift
    const driftResult = await reconcileNonceDrift(txId, sourceChainId, 'vaultBridge', tssSender, localNonce, chainNonce)
    setLocalNonce(destinationChainId, tssSender, chainNonce)
    localNonce = getLocalNonce(destinationChainId, tssSender)
    if (driftResult?.receiptId) {
      console.log(`[double-exec-guard] ${txId} was completed during nonce drift reconciliation`)
      await refreshLastBridgeInTime(txId, 'vaultBridge', destinationChainId)
      return 'completed'
    }
  } else if (localNonce != null && localNonce > chainNonce) {
    // This shouldn't happen — local is ahead of chain
    console.warn(`[nonce-manager] Local nonce ahead of chain on ${destChainName}: local=${localNonce}, chain=${chainNonce}`)
    // Abort this transaction to avoid potential double execution
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `local nonce ahead of chain on ${destChainName}`)
    return 'failed'
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
    try {
      await retryOperation(() => injectEthereumTx(destinationChainId, cached.txHash, cached.signedTx), {
        txId: cached.txHash,
        maxRetries: 3,
      })
      const receipt = await getChainTransactionReceipt(destinationChainId, cached.txHash)
      if (receipt?.status === 1) {
        const block = await chainRpcConfig.withChainHttpProvider(
          destinationChainId, (provider) => provider.getBlock(receipt.blockNumber), { maxRetries: 3 })
        destChainState.lastBridgeInTime = block.timestamp
        updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, cached.txHash, tssSender, senderNonce)
        signedTxCache.delete(normalizedTxId)
        incrementLocalNonce(destinationChainId, tssSender)
        return 'completed'
      } else if (receipt?.status === 0) {
        console.log(`[nonce-guard] Cached tx reverted on ${destChainName}: ${cached.txHash}`)
        updateTxStatusInLocalDB(txId, TransactionStatus.REVERTED, cached.txHash, tssSender, senderNonce)
        signedTxCache.delete(normalizedTxId)
        incrementLocalNonce(destinationChainId, tssSender)
        return 'reverted'
      }
    } catch (e) {
      console.warn(`[nonce-guard] Rebroadcast failed, will re-sign: ${e instanceof Error ? e.message : e}`)
    }
  } else if (cached) {
    signedTxCache.delete(normalizedTxId)
  }

  let currentGasPrice = await chainRpcConfig.withChainHttpProvider(
    destinationChainId,
    (provider) => provider.getGasPrice(),
    { maxRetries: 3 },
  )

  // Apply gas price logic based on destination chain configuration
  for (const tierGwei of destChainState.gasPriceTiersBN) {
    if (currentGasPrice.lt(tierGwei)) {
      currentGasPrice = tierGwei
      break
    }
  }

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

  // Step 5: Sign via TSS (destination chain keystore)
  const signedTx = await signEthereumTransaction(tx, digest, destinationChainId, channelId, channelPassword)
  if (!signedTx) {
    console.log(`Failed to sign EVM-to-EVM transaction on ${destChainName}, skipping`, txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `failed to sign EVM-to-EVM transaction on ${destChainName}`)
    return 'failed'
  }

  // Step 6: Cache signed tx + broadcast
  const txHash = ethersUtils.keccak256(signedTx as string)
  signedTxCache.set(normalizedTxId, { signedTx: signedTx as string, txHash, nonce: senderNonce })

  const signerBalance = await chainRpcConfig.withChainHttpProvider(
    destinationChainId,
    (provider) => provider.getBalance(tssSender),
    { maxRetries: 3 },
  )
  console.log(`Signer ${tssSender} balance on ${destChainName}: ${ethersUtils.formatEther(signerBalance)} ETH`)
  console.log(`Injecting EVM-to-EVM transaction on ${destChainName}`, txHash)
  let res: { success: boolean; reason?: string }
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
    await refreshBridgeStateOnRevert(reason, destinationChainId)
  }

  let receipt = await getChainTransactionReceipt(destinationChainId, txHash)
  if (!receipt) {
    // Tx may have been broadcast but not yet mined — retry once after a short delay
    await delay_ms(3000)
    receipt = await getChainTransactionReceipt(destinationChainId, txHash)
  }
  if (receipt) {
    if (receipt.status === 1) {
      console.log(
        `EVM-to-EVM transaction successful - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      )
      const block = await chainRpcConfig.withChainHttpProvider(
        destinationChainId,
        (provider) => provider.getBlock(receipt.blockNumber),
        { maxRetries: 3 },
      )
      destChainState.lastBridgeInTime = block.timestamp
      updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, txHash, tssSender, senderNonce, '')
      signedTxCache.delete(normalizedTxId)
      incrementLocalNonce(destinationChainId, tssSender)
      return 'completed'
    } else {
      console.log(
        `EVM-to-EVM transaction failed in execution - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, `failed in execution on ${destChainName}`)
      updateTxStatusInLocalDB(txId, TransactionStatus.REVERTED, txHash, tssSender, senderNonce, '')
      signedTxCache.delete(normalizedTxId)
      incrementLocalNonce(destinationChainId, tssSender)  // nonce consumed even on revert
      return 'reverted'
    }
  } else {
    console.log(
      `EVM-to-EVM transaction failed - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      res.reason,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send failed on ${destChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, txHash, tssSender, senderNonce, res.reason as string)
    // If 'failed' status is sent, remove it from the queue ( so that we don't process it again )
    removeFromPendingTxQueue(txId)
    // Don't increment nonce — tx may not have been broadcast/mined
    // signedTxCache is NOT cleared — we may want to rebroadcast on next attempt
    return 'failed'
  }
}

async function processTokenToCoin(
  to: string,
  value: any,
  txId: string,
  sourceChainId: number,
  txTimestampMs: number,
): Promise<ProcessOutcome> {
  console.log('Processing token to coin transaction', {to, value, txId, sourceChainId})

  const sourceChainState = chainStateByChainId.get(sourceChainId)
  if (!sourceChainState) {
    console.error(`[ProcessTokenToCoin] Source chain provider not found for chainId ${sourceChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `source chain provider not found for chainId ${sourceChainId}`)
    return 'failed'
  }

  const sourceChainName = sourceChainState.config.name
  console.log(`Processing transaction from ${sourceChainName}`)

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
  tx.timestamp = deriveLocalFutureTimestamp(txId, txTimestampMs, currentCycleRecord)
  if (verboseLogs) {
    console.log('Current timestamp:', new Date(Date.now()))
    console.log('Future timestamp confirmed:', new Date(tx.timestamp))
    console.log('Wait time:', tx.timestamp - Date.now())
    console.log('Transaction:', tx)
  }
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
    return 'failed'
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

  let fetchReceiptRetry = 3
  if (res.success === true) {
    fetchReceiptRetry = 10 // Higher retries for successful transactions
  }

  await sleep(5000) // wait for 5 seconds
  
  const receipt = await getLiberdusReceipt(signedTxId, fetchReceiptRetry)
  const liberdusTssSender = sourceChainState.config.tssSenderAddress
  const liberdusNonce = tx.timestamp
  if (receipt) {
    if (receipt.success === true) {
      console.log(
        `Transaction is successful - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId}`,
      )
      updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, signedTxId, liberdusTssSender, liberdusNonce)
      return 'completed'
    } else {
      console.log(
        `Transaction is failed in execution - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId} with reason ${receipt.reason}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, receipt.reason)
      updateTxStatusInLocalDB(txId, TransactionStatus.REVERTED, signedTxId, liberdusTssSender, liberdusNonce, receipt.reason)
      return 'reverted'
    }
  } else {
    console.log(
      `Transaction is failed - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId} with reason ${res.reason}`,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send failed from ${sourceChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, signedTxId, liberdusTssSender, liberdusNonce, res.reason as string)
    // If 'failed' status is sent, remove it from the queue ( so that we don't process it again )
    removeFromPendingTxQueue(txId)
    return 'failed'
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
        // Contract reverts (execution failed, retrying won't help)
        'reverted with reason string',
        'execution reverted',
        'CALL_EXCEPTION',
        'Transaction Failed',
        // Insufficient funds for gas
        'insufficient funds',
        'INSUFFICIENT_FUNDS',
        // Liberdus: tx already accepted by the network, no need to retry
        'Transaction is already in queue',
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
  
  console.log('📊 Memory Usage:', {
    rss: formatMB(usage.rss),
    heapTotal: formatMB(usage.heapTotal),
    heapUsed: formatMB(usage.heapUsed),
    external: formatMB(usage.external),
    txQueueMapSize: txQueueMap.size,
    processingSize: processingTransactionIds.size,
    pendingTxQueueLength: pendingTxQueue.length,
  })
  
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

function deriveLocalFutureTimestamp(
  txId: string,
  txTimestampMs: number,
  currentCycleRecord: {start: number; duration: number},
): number {
  const stepMs = Math.max((currentCycleRecord.duration || 10) * 1000, 10_000)
  let futureTimestamp = currentCycleRecord.start * 1000 + currentCycleRecord.duration * 1000
  const minFuture = Math.max(txTimestampMs + 60_000, Date.now() + 30_000)
  while (futureTimestamp < minFuture) {
    futureTimestamp += stepMs
  }
  const deterministicOffsetSteps = parseInt(normalizeTxId(txId).slice(-2), 16) % 3
  return futureTimestamp + deterministicOffsetSteps * stepMs
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

  if (!operationFlag) {
    console.log('\nUsage: ts-node scripts/tss-party.ts <party_index>')
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
      removeFromPendingTxQueue(txId)
      processingTransactionIds.delete(txId)
      return
    }

    // Verify with the local DB that this tx hasn't already been completed
    const preProcess = reconcileTxStatusWithLocalDB(txId, 'pre-process')
    if (preProcess != null) {
      removeFromPendingTxQueue(txId)
      const tssSender = validTx.type === 'vaultBridge'
        ? chainConfigs.secondaryChainConfig!.tssSenderAddress!
        : getChainConfigById(chainConfigs, validTx.chainId)!.tssSenderAddress!
      if (preProcess === 'completed') {
        syncLocalNonceFromDB(validTx.type, validTx.chainId, tssSender)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
      } else if (preProcess === 'reverted') {
        syncLocalNonceFromDB(validTx.type, validTx.chainId, tssSender)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'reverted' })
        appendToFailedTxsLogs(validTx, 'already reverted in local DB at pre-process')
      } else if (preProcess === 'failed') {
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        appendToFailedTxsLogs(validTx, 'already failed in local DB at pre-process')
      }
      await refreshLastBridgeInTime(txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
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
          reject(new Error('Transaction processing timed out'))
        }, TX_PROCESSING_TIMEOUT_MS)
      })
      // wait for either the transaction to be processed or the timeout
      const outcome = await Promise.race([processPromise, failPromise]) as ProcessOutcome
      if (outcome === 'completed') {
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
        console.log('Transaction processed successfully:', validTx)
        // Remove the tx from the queue
        removeFromPendingTxQueue(txId)
      } else if (outcome === 'reverted') {
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'reverted' })
        appendToFailedTxsLogs(validTx, 'reverted on-chain')
        console.warn(`Transaction ${validTx.txId} was executed but reverted on-chain`)
        removeFromPendingTxQueue(txId)
      } else if (outcome === 'failed') {
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        console.warn(`Transaction ${validTx.txId} reported failed outcome during processing`)
      } else if (outcome === 'skipped_db_completed') {
        console.log(`Transaction ${validTx.txId} was already completed in local DB (pre-sign), skipping`)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
        removeFromPendingTxQueue(txId)
        const tssSender = validTx.type === 'vaultBridge'
          ? chainConfigs.secondaryChainConfig!.tssSenderAddress!
          : getChainConfigById(chainConfigs, validTx.chainId)!.tssSenderAddress!
        syncLocalNonceFromDB(validTx.type, validTx.chainId, tssSender)
        await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
      } else if (outcome === 'skipped_db_reverted') {
        console.log(`Transaction ${validTx.txId} was already reverted in local DB (pre-sign), skipping`)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'reverted' })
        appendToFailedTxsLogs(validTx, 'already reverted in local DB before signing')
        removeFromPendingTxQueue(txId)
        const tssSender = validTx.type === 'vaultBridge'
          ? chainConfigs.secondaryChainConfig!.tssSenderAddress!
          : getChainConfigById(chainConfigs, validTx.chainId)!.tssSenderAddress!
        syncLocalNonceFromDB(validTx.type, validTx.chainId, tssSender)
        await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
      } else if (outcome === 'skipped_db_failed') {
        console.log(`Transaction ${validTx.txId} was already failed in local DB (pre-sign), skipping`)
        removeFromPendingTxQueue(txId)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        appendToFailedTxsLogs(validTx, 'already failed in local DB before signing')
        await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
      }

      // Check memory usage after successful transaction
      checkPostTransactionMemory(validTx.txId, 'transaction-success')
      
      // Force cleanup after successful transaction processing
      if (global.gc) {
        tryGC()
      }
    } catch (error: any) {
      if (error.message === bnbTss.SIGNING_TIMEOUT_ERROR) {
        console.log('Transaction signing timed out', validTx.txId)
        const finalStatus = checkTxStatusFromLocalDB(validTx.txId)
        if (finalStatus === TransactionStatus.COMPLETED) {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
          removeFromPendingTxQueue(txId)
          await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
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
          console.log(`[${bnbTss.SIGNING_TIMEOUT_ERROR}] ${validTx.txId} already COMPLETED in local DB`)
        } else {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
          appendToFailedTxsLogs(validTx, bnbTss.SIGNING_TIMEOUT_ERROR)
          console.warn(`[${bnbTss.SIGNING_TIMEOUT_ERROR}] ${validTx.txId} not completed in local DB`)
        }
        checkPostTransactionMemory(validTx.txId, bnbTss.SIGNING_TIMEOUT_ERROR)
        if (global.gc) {
          tryGC()
        }
      } else if (error.message === 'Transaction processing timed out') {
        // Handle timeout errors more gracefully
        console.warn('⏱️ Transaction timed out, marking as failed and cleaning up:', validTx.txId)
        checkPostTransactionMemory(validTx.txId, 'timeout-error')
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        appendToFailedTxsLogs(validTx, 'timeout')
        
        // Force cleanup after timeout
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
      console.error('Error processing transaction:', error)
    } finally {
      // Remove from processing set when done (success or failure)
      const endTime = Date.now()
      console.log(`Time taken for processTransaction: ${endTime - startTime} ms`)
      processingTransactionIds.delete(validTx.txId)
    }
  }

  const handleTransactionQueue = () => {
    console.log('Running handleTransactionQueue', new Date().toISOString())

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
