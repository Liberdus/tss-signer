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

// Transaction interface matching the observer DB schema
export interface Transaction {
  txId: string
  sender: string
  value: string
  type: TransactionType
  txTimestamp: number
  chainId: number
  status: TransactionStatus
  receiptId: string;
  reason?: string | null; // Optional field for error reason
  createdAt?: string
  updatedAt?: string
}


export enum TransactionStatus {
  PENDING = 0,
  PROCESSING = 1,
  COMPLETED = 2,
  FAILED = 3,
  REVERTED = 4, // tx executed but reverted on-chain
}

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

export enum TransactionType {
  BRIDGE_IN = 0,    // COIN to TOKEN (Liberdus → EVM)
  BRIDGE_OUT = 1,   // TOKEN to COIN (EVM → Liberdus)
  BRIDGE_VAULT = 2, // VAULT to SECONDARY (vault chain → secondary EVM chain)
}

const parsedIdx = process.argv[2]
const operationFlag = process.argv[3]

const verboseLogs = true

const serverStartTime = Date.now()

const params: ParamsConfig = paramsConfigRaw
const chainConfigs: ChainConfigs = chainConfigsRaw

let t = params.threshold
let n = params.parties

const SIGN_POLL_DELAY_MS = 100

// Unified BridgedOut event ABI (all contracts use this 5-param signature)
// Shared bridge contract ABI for state reads and bridgeIn
const BRIDGE_CONTRACT_ABI = [
  'function bridgeInCooldown() view returns (uint256)',
  'function maxBridgeInAmount() view returns (uint256)',
  'function lastBridgeInTime() view returns (uint256)',
  'function bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId) public',
]
const BRIDGE_CONTRACT_IFACE = new ethersUtils.Interface(BRIDGE_CONTRACT_ABI)


const collectorHost = process.env.COLLECTOR_HOST || chainConfigs.collectorHost;
const proxyServerHost = process.env.PROXY_SERVER_HOST || chainConfigs.proxyServerHost;

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
    },
  ]),
)

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
        ),
        chainRpcConfig.withChainHttpProvider(chainId, (provider) =>
          provider.call({to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('maxBridgeInAmount')}),
        ),
        chainRpcConfig.withChainHttpProvider(chainId, (provider) =>
          provider.call({to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('lastBridgeInTime')}),
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
      )
      chainState.lastBridgeInTime = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('lastBridgeInTime', lastTimeRaw)[0].toNumber()
      const lastBridgeInStr = chainState.lastBridgeInTime > 0
        ? new Date(chainState.lastBridgeInTime * 1000).toISOString()
        : 'never'
      console.log(`Bridge lastBridgeInTime fetched for ${chainState.config.name}: ${lastBridgeInStr}`)
    } else if (fields === 'bridgeInCooldown') {
      const cooldownRaw = await chainRpcConfig.withChainHttpProvider(chainId, (provider) =>
        provider.call({to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('bridgeInCooldown')}),
      )
      chainState.bridgeInCooldown = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('bridgeInCooldown', cooldownRaw)[0].toNumber()
      console.log(`Bridge bridgeInCooldown fetched for ${chainState.config.name}: ${chainState.bridgeInCooldown}s`)
    } else if (fields === 'maxBridgeInAmount') {
      const maxAmountRaw = await chainRpcConfig.withChainHttpProvider(chainId, (provider) =>
        provider.call({to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('maxBridgeInAmount')}),
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
  txId: string,
  chainName: string,
): boolean {
  if (chainState.maxBridgeInAmount.isZero()) return true
  if (value.lte(chainState.maxBridgeInAmount)) return true
  const reason = `Amount ${ethersUtils.formatEther(value)} exceeds bridge-in limit ${ethersUtils.formatEther(chainState.maxBridgeInAmount)} on ${chainName}`
  console.error(reason)
  updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, '', reason)
  // If 'failed' status is sent, remove it from the queue ( so that we don't process it again )
  removeFromPendingTxQueue(txId)
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
const FINAL_STATUS_POLL_INTERVAL = 3 * 1000 // 3s
const FINAL_STATUS_TIMEOUT_MS = 20 * 1000 // 20s
const TX_PROCESSING_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes ( Including the bridgeInCooldown 1-minute)

const TX_CLEANUP_MAX_AGE = 24 * 60 * 60 * 1000 // 24 hours for all statuses

const TX_DATA_STORE_MAX_ENTRIES = 500
const TX_DATA_STORE_MAX_FILES = 5
// Compiled once at startup; ourParty.idx is known at module-init time
const TX_DATA_STORE_FILE_PATTERN = new RegExp(`^tx_data_store_${ourParty.idx}_\\d+\\.ndjson$`)
// Tracks the active tx_data_store file path in memory to avoid readdirSync on every append
let txDataStoreCurrentFile: string | null = null
let txDataStoreCurrentEntries = 0

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
    for (let i = pendingTxQueue.length - 1; i >= 0; i--) {
      if (removedTxIds.has(pendingTxQueue[i].txId)) {
        appendToFailedTxsLogs(
          pendingTxQueue[i],
          'removed from pending queue during cleanup due to max age',
        )
        pendingTxQueue.splice(i, 1)
      }
    }
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
    global.gc()
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

const saveQueueToFile = (partyIdx: number): void => {
  const party = partyIdx === undefined ? 'all' : String(partyIdx)
  const filePath = path.join(KEYSTORE_DIR, `queue_party_${party}.json`)
  const data = {
    map: Array.from(txQueueMap.entries()),
    pending: pendingTxQueue.map(tx => ({
      ...tx,
      value: tx.value.toString(),
      receipt: undefined,
    })),
  }
  fs.writeFileSync(filePath, JSON.stringify(data))
  console.log(`Queue for party ${party} saved to ${filePath}`)
}

const loadQueueFromFile = (partyIdx: number): void => {
  const party = partyIdx === undefined ? 'all' : String(partyIdx)
  const filePath = path.join(KEYSTORE_DIR, `queue_party_${party}.json`)
  if (!fs.existsSync(filePath)) return

  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))

    // Restore txQueueMap
    if (Array.isArray(data.map)) {
      for (const [txId, entry] of data.map as [string, TxQueueEntry][]) {
        txQueueMap.set(txId, entry)
      }
    }

    // Restore pendingTxQueue — parse BigNumber from string
    if (Array.isArray(data.pending)) {
      for (const tx of data.pending) {
        pendingTxQueue.push({
          ...tx,
          value: ethers.BigNumber.from(tx.value),
        })
      }
    }

    // Legacy format support: old files used "queue" key
    if (!data.pending && Array.isArray(data.queue)) {
      for (const tx of data.queue) {
        pendingTxQueue.push({ ...tx, value: ethers.BigNumber.from(tx.value?.hex ?? tx.value ?? '0') })
      }
      if (Array.isArray(data.map)) {
        for (const [txId, oldEntry] of data.map) {
          txQueueMap.set(txId, {
            txTimestamp: oldEntry.txTimestamp ?? oldEntry.timestamp ?? Date.now(),
            status: oldEntry.status ?? 'pending',
          })
        }
      }
    }

    console.log(`Queue for party ${party} loaded from ${filePath}: ${txQueueMap.size} map entries, ${pendingTxQueue.length} pending`)
  } catch (err) {
    console.error(`Failed to load queue from ${filePath}:`, err)
  }
}

function appendToTxDataStore(txData: TransactionQueueItem): void {
  try {
    // On first call after startup, do a one-time scan to find the current file
    if (txDataStoreCurrentFile === null) {
      const existing = fs.readdirSync(KEYSTORE_DIR)
        .filter(f => TX_DATA_STORE_FILE_PATTERN.test(f))
        .sort()
      if (existing.length > 0) {
        txDataStoreCurrentFile = path.join(KEYSTORE_DIR, existing[existing.length - 1])
        const content = fs.readFileSync(txDataStoreCurrentFile, 'utf8')
        txDataStoreCurrentEntries = content.split('\n').filter(Boolean).length
      }
    }

    if (!txDataStoreCurrentFile || txDataStoreCurrentEntries >= TX_DATA_STORE_MAX_ENTRIES) {
      // Roll to a new file; scan once here to prune oldest if over the limit
      const allFiles = fs.readdirSync(KEYSTORE_DIR)
        .filter(f => TX_DATA_STORE_FILE_PATTERN.test(f))
        .sort()
      while (allFiles.length >= TX_DATA_STORE_MAX_FILES) {
        fs.unlinkSync(path.join(KEYSTORE_DIR, allFiles.shift()!))
      }
      txDataStoreCurrentFile = path.join(KEYSTORE_DIR, `tx_data_store_${ourParty.idx}_${Date.now()}.ndjson`)
      txDataStoreCurrentEntries = 0
    }

    const line = JSON.stringify({
      txId: txData.txId,
      from: txData.from,
      value: txData.value.toString(),
      type: txData.type,
      chainId: txData.chainId,
      txTimestamp: txData.txTimestamp,
      addedAt: Date.now(),
    }) + '\n'
    fs.appendFileSync(txDataStoreCurrentFile, line)
    txDataStoreCurrentEntries += 1
  } catch (err) {
    console.error('[txDataStore] Failed to append tx data:', err)
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
  failedReason = '',
): void {
  try {
    const normalizedTxId = normalizeTxId(txId)
    const normalizedReceiptId = receiptId ? normalizeTxId(receiptId) : receiptId

    const result = TransactionDB.updateTransactionStatus(
      normalizedTxId,
      status as unknown as TransactionDB.TransactionStatus,
      normalizedReceiptId,
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
    const transactions: Transaction[] = (dbTxs as unknown as Transaction[])
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
      appendToTxDataStore(txData)

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
      saveQueueToFile(ourParty.idx)
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
    return tx.status as unknown as TransactionStatus
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`[checkTxStatus] DB read failed for ${txId}: ${errorMessage}`)
  }
}

async function waitForLocalDBFinalStatus(
  txId: string,
  timeoutMs: number,
): Promise<TransactionStatus.COMPLETED | TransactionStatus.FAILED | TransactionStatus.REVERTED> {
  const startTime = Date.now()
  while (true) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timed out waiting for local DB final status for ${txId}`)
    }
    try {
      const status = checkTxStatusFromLocalDB(txId)
      if (status === TransactionStatus.COMPLETED || status === TransactionStatus.FAILED || status === TransactionStatus.REVERTED) {
        return status
      }
      if (status == null) {
        console.warn(`[wait-final] ${txId} not found in local DB yet, waiting...`)
      } else {
        console.log(`[wait-final] ${txId} still ${txStatusLabel(status)} in local DB, waiting...`)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.warn(`[wait-final] Local DB status check failed for ${txId}, retrying... ${errorMessage}`)
    }
    await delay_ms(FINAL_STATUS_POLL_INTERVAL)
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

function getBnbTssExpectedAddresses(): Record<number, string> {
  const expected: Record<number, string> = {}
  for (const chainId of getEffectiveChainIds()) {
    const config = getChainConfigById(chainConfigs, chainId)
    if (config?.tssSenderAddress) {
      expected[chainId] = config.tssSenderAddress
    }
  }
  return expected
}

async function validateBnbTssSetup(): Promise<void> {
  const expectedAddressesByChainId = getBnbTssExpectedAddresses()
  const chainIds = Object.keys(expectedAddressesByChainId).map(Number)
  if (chainIds.length === 0) {
    throw new Error('useBnbTss is enabled, but no chain has tssSenderAddress configured')
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
  console.log(`Processing transaction on ${targetChainName}`)

  await waitForBridgeCooldown(chainState, targetChainName)
  if (!checkMaxBridgeAmount(chainState, value, txId, targetChainName)) {
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed on ${targetChainName}`)
    return 'failed'
  }

  const senderNonce = await chainRpcConfig.withChainHttpProvider(
    targetChainId,
    (provider) => provider.getTransactionCount(chainState.config.tssSenderAddress),
  )
  let currentGasPrice = await chainRpcConfig.withChainHttpProvider(
    targetChainId,
    (provider) => provider.getGasPrice(),
  )

  // Apply gas price logic based on chain configuration
  const gasTiers = chainState.config.gasConfig.gasPriceTiers
  for (let i = 0; i < gasTiers.length; i++) {
    const tierGwei = ethersUtils.parseUnits(gasTiers[i].toString(), 'gwei')
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
    chainId: targetChainId === 31338 ? 31337 : targetChainId, // [HACK] In local development, secondary contract is deployed as 31338 for chainId, but the network is 31337
  }
  console.log(`eth tx to sign on ${targetChainName}`, tx)
  const unsignedTx = ethersUtils.serializeTransaction(tx)
  let digest = ethersUtils.keccak256(unsignedTx)
  const channelId = deriveDeterministicChannelId(normalizeTxId(txId), txTimestampMs)
  const channelPassword = deriveDeterministicChannelPassword(channelId, cryptoInitKey)

  const dbStatusCoinToToken = reconcileTxStatusWithLocalDB(txId, 'pre-sign')
  if (dbStatusCoinToToken != null) return dbStatusCoinToToken === 'completed' ? 'skipped_db_completed' : dbStatusCoinToToken === 'reverted' ? 'skipped_db_reverted' : 'skipped_db_failed'

  // Use chain-specific keystore for signing
  const signedTx = await signEthereumTransaction(tx, digest, targetChainId, channelId, channelPassword)
  if (!signedTx) {
    console.log(`Failed to sign Ethereum transaction on ${targetChainName}, skipping`, txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `failed to sign Ethereum transaction on ${targetChainName}`)
    return 'failed'
  }
  // precompute tx hash from signedTx
  const txHash = ethersUtils.keccak256(signedTx as string)
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

  let receipt = await chainRpcConfig.withChainHttpProvider(
    targetChainId,
    (provider) => provider.getTransactionReceipt(txHash),
    {maxRetries: 1},
  )
  if (!receipt) {
    // Tx may have been broadcast but not yet mined — retry once after a short delay
    await delay_ms(3000)
    receipt = await chainRpcConfig.withChainHttpProvider(
      targetChainId,
      (provider) => provider.getTransactionReceipt(txHash),
      {maxRetries: 1},
    )
  }
  if (receipt) {
    if (receipt.status === 1) {
      console.log(
        `Transaction is successful - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      )
      const block = await chainRpcConfig.withChainHttpProvider(
        targetChainId,
        (provider) => provider.getBlock(receipt.blockNumber),
      )
      chainState.lastBridgeInTime = block.timestamp
      updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, txHash)
      return 'completed'
    } else {
      console.log(
        `Transaction failed in execution - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, `failed in execution on ${targetChainName}`)
      updateTxStatusInLocalDB(txId, TransactionStatus.REVERTED, txHash, '')
      return 'reverted'
    }
  } else {
    console.log(
      `Transaction failed - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      res.reason,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send failed on ${targetChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, txHash, res.reason as string)
    // If 'failed' status is sent, remove it from the queue ( so that we don't process it again )
    removeFromPendingTxQueue(txId)
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
  console.log(`Processing vault bridge: ${sourceChainName} -> ${destChainName}`)

  await waitForBridgeCooldown(destChainState, destChainName)
  if (!checkMaxBridgeAmount(destChainState, value, txId, destChainName)) {
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed on ${destChainName}`)
    return 'failed'
  }

  const senderNonce = await chainRpcConfig.withChainHttpProvider(
    destinationChainId,
    (provider) => provider.getTransactionCount(destChainState.config.tssSenderAddress),
  )
  let currentGasPrice = await chainRpcConfig.withChainHttpProvider(
    destinationChainId,
    (provider) => provider.getGasPrice(),
  )

  // Apply gas price logic based on destination chain configuration
  const gasTiers = destChainState.config.gasConfig.gasPriceTiers
  for (let i = 0; i < gasTiers.length; i++) {
    const tierGwei = ethersUtils.parseUnits(gasTiers[i].toString(), 'gwei')
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
    chainId: destChainState.config.chainId === 31338 ? 31337 : destChainState.config.chainId, // [HACK] In local development, secondary contract is deployed as 31338 for chainId, but the network is 31337
  }
  console.log(`EVM-to-EVM tx to sign on ${destChainName}`, tx)
  const unsignedTx = ethersUtils.serializeTransaction(tx)
  let digest = ethersUtils.keccak256(unsignedTx)
  const channelId = deriveDeterministicChannelId(normalizeTxId(txId), txTimestampMs)
  const channelPassword = deriveDeterministicChannelPassword(channelId, cryptoInitKey)

  const dbStatusVaultBridge = reconcileTxStatusWithLocalDB(txId, 'pre-sign')
  if (dbStatusVaultBridge != null) return dbStatusVaultBridge === 'completed' ? 'skipped_db_completed' : dbStatusVaultBridge === 'reverted' ? 'skipped_db_reverted' : 'skipped_db_failed'

  // Use destination chain's keystore for signing
  const signedTx = await signEthereumTransaction(tx, digest, destinationChainId, channelId, channelPassword)
  if (!signedTx) {
    console.log(`Failed to sign EVM-to-EVM transaction on ${destChainName}, skipping`, txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `failed to sign EVM-to-EVM transaction on ${destChainName}`)
    return 'failed'
  }
  // precompute tx hash from signedTx
  const txHash = ethersUtils.keccak256(signedTx as string)
  const signerBalance = await chainRpcConfig.withChainHttpProvider(
    destinationChainId,
    (provider) => provider.getBalance(destChainState.config.tssSenderAddress),
  )
  console.log(`Signer ${destChainState.config.tssSenderAddress} balance on ${destChainName}: ${ethersUtils.formatEther(signerBalance)} ETH`)
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

  const receipt = await chainRpcConfig.withChainHttpProvider(
    destinationChainId,
    (provider) => provider.getTransactionReceipt(txHash),
    {maxRetries: 1},
  )
  if (receipt) {
    if (receipt.status === 1) {
      console.log(
        `EVM-to-EVM transaction successful - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      )
      const block = await chainRpcConfig.withChainHttpProvider(
        destinationChainId,
        (provider) => provider.getBlock(receipt.blockNumber),
      )
      destChainState.lastBridgeInTime = block.timestamp
      updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, txHash)
      return 'completed'
    } else {
      console.log(
        `EVM-to-EVM transaction failed in execution  - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, `failed in execution on ${destChainName}`)
      updateTxStatusInLocalDB(txId, TransactionStatus.REVERTED, txHash, '')
      return 'reverted'
    }
  } else {
    console.log(
      `EVM-to-EVM transaction failed - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      res.reason,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send failed on ${destChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, txHash, res.reason as string)
    // If 'failed' status is sent, remove it from the queue ( so that we don't process it again )
    removeFromPendingTxQueue(txId)
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

  const dbStatusTokenToCoin = reconcileTxStatusWithLocalDB(txId, 'pre-sign')
  if (dbStatusTokenToCoin != null) return dbStatusTokenToCoin === 'completed' ? 'skipped_db_completed' : dbStatusTokenToCoin === 'reverted' ? 'skipped_db_reverted' : 'skipped_db_failed'

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
  if (receipt) {
    if (receipt.success === true) {
      console.log(
        `Transaction is successful - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId}`,
      )
      updateTxStatusInLocalDB(txId, TransactionStatus.COMPLETED, signedTxId)
      return 'completed'
    } else {
      console.log(
        `Transaction is failed in execution - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId} with reason ${receipt.reason}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, receipt.reason)
      updateTxStatusInLocalDB(txId, TransactionStatus.REVERTED, signedTxId, '')
      return 'reverted'
    }
  } else {
    console.log(
      `Transaction is failed - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId} with reason ${res.reason}`,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send failed from ${sourceChainName}`)
    updateTxStatusInLocalDB(txId, TransactionStatus.FAILED, signedTxId, res.reason as string)
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
      
      // Clear any error references for garbage collection
      lastError = null as any
      
      return result
    } catch (error) {
      lastError = error as Error

      // Force garbage collection of error objects on final attempt
      if (global.gc && attempt === maxRetries) {
        global.gc()
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
    global.gc()
    
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
      global.gc()
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
      global.gc()
      
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
  
  // First, backup the current queue state to persistent storage
  console.log('💾 Backing up queue state before emergency cleanup...')
  saveQueueToFile(ourParty.idx)
  
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

  // Aggressive cleanup — remove anything older than 24h
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
  
  // Update the regular queue file after cleanup
  saveQueueToFile(ourParty.idx)
  
  // Force GC after emergency cleanup
  if (global.gc) {
    global.gc()
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
    }
    count++
    await sleep(1000)
  }
  if (!response) return null
  return response.data.transaction
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
        balance = ethersUtils.formatEther('0x' + response.data.account?.data?.balance?.value)
        break
      }
    } catch (e) {
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
  if (success) return cycles[0].cycleRecord
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

  // Load persisted queue state
  loadQueueFromFile(ourParty.idx)

  // Startup recovery: verify pending/processing entries against local DB
  console.log('🔄 Running startup recovery check against local DB...')
  const txIdsToCheck = [...txQueueMap.entries()]
    .filter(([, entry]) => entry.status === 'pending' || entry.status === 'processing')
    .map(([txId]) => txId)

  for (const txId of txIdsToCheck) {
    try {
      const dbStatus = checkTxStatusFromLocalDB(txId)
      const entry = txQueueMap.get(txId)!

      if (dbStatus === TransactionStatus.COMPLETED) {
        entry.status = 'completed'
        removeFromPendingTxQueue(txId)
        console.log(`[startup] ${txId} already COMPLETED in local DB, skipping`)
      } else if (dbStatus === TransactionStatus.REVERTED) {
        entry.status = 'reverted'
        removeFromPendingTxQueue(txId)
        console.log(`[startup] ${txId} already REVERTED in local DB, skipping`)
      } else if (dbStatus === TransactionStatus.FAILED) {
        entry.status = 'failed'
        const txData = pendingTxQueue.find(t => t.txId === txId)
        if (txData) {
          appendToFailedTxsLogs(txData, 'already failed in local DB at startup')
          removeFromPendingTxQueue(txId)
        }
        console.log(`[startup] ${txId} already FAILED in local DB, skipping`)
      } else {
        // PENDING or PROCESSING in DB — ensure txData is in pendingTxQueue
        const alreadyInQueue = pendingTxQueue.some(t => t.txId === txId)
        if (!alreadyInQueue) {
          // Was processing when we crashed — recover tx data directly from local DB
          const tx = TransactionDB.getTransactionById(txId) as unknown as Transaction | null
          if (
            tx &&
            tx.txId &&
            isNormalizedTxId(tx.txId) &&
            tx.txTimestamp &&
            tx.sender &&
            tx.value &&
            tx.chainId != null &&
            getChainConfigById(chainConfigs, tx.chainId) != null
          ) {
            const bridgeType: TransactionQueueItem['type'] =
              tx.type === TransactionType.BRIDGE_IN
                ? 'coinToToken'
                : tx.type === TransactionType.BRIDGE_VAULT
                  ? 'vaultBridge'
                  : 'tokenToCoin'
            const txData: TransactionQueueItem = {
              receipt: null as any,
              from: tx.sender,
              value: ethers.BigNumber.from(tx.value),
              txId: tx.txId,
              type: bridgeType,
              chainId: tx.chainId,
              txTimestamp: tx.txTimestamp,
            }
            pendingTxQueue.push(txData)
            entry.status = 'pending'
            console.log(`[startup] Recovered in-flight tx ${txId} from local DB, verified, and re-queued`)
          } else {
            entry.status = 'failed'
            console.warn(`[startup] Cannot recover verified txData from local DB for ${txId}, marking failed`)
          }
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.warn(`[startup] Local DB check failed for ${txId}, skipping: ${errorMessage}`)
    }
  }

  // Sort pendingTxQueue by txTimestamp
  pendingTxQueue.sort((a, b) => (a.txTimestamp ?? Infinity) - (b.txTimestamp ?? Infinity))
  console.log(`[startup] Recovery complete. pendingTxQueue: ${pendingTxQueue.length}, txQueueMap: ${txQueueMap.size}`)

  // Run initial cleanup
  cleanupOldTransactions()

  async function processTransaction(validTx: any): Promise<void> {
    const {txId} = validTx
    const startTime = Date.now()

    // const getRemainingProcessingTimeMs = (): number =>
    //   Math.max(0, TX_PROCESSING_TIMEOUT_MS - (Date.now() - startTime))
    
    // Check if this transaction was already completed to avoid duplicate processing
    if (txQueueMap.get(txId)?.status === 'completed') {
      console.log(`⏩ Transaction ${txId} was recently completed, skipping duplicate processing`)
      txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
      removeFromPendingTxQueue(txId)
      processingTransactionIds.delete(txId)
      return
    }

    // Verify with the local DB that this tx hasn't already been completed/is being processed
    const preProcessStatus = reconcileTxStatusWithLocalDB(txId, 'pre-process')
    if (preProcessStatus != null) {
      removeFromPendingTxQueue(txId)
      if (preProcessStatus === 'completed') {
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
      } else if (preProcessStatus === 'reverted') {
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'reverted' })
        appendToFailedTxsLogs(validTx, 'already reverted in local DB at pre-process')
      } else if (preProcessStatus === 'failed') {
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
        await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
      } else if (outcome === 'skipped_db_reverted') {
        console.log(`Transaction ${validTx.txId} was already reverted in local DB (pre-sign), skipping`)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'reverted' })
        appendToFailedTxsLogs(validTx, 'already reverted in local DB before signing')
        removeFromPendingTxQueue(txId)
        await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
      } else if (outcome === 'skipped_db_failed') {
        console.log(`Transaction ${validTx.txId} was already failed in local DB (pre-sign), skipping`)
        removeFromPendingTxQueue(txId)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        appendToFailedTxsLogs(validTx, 'already failed in local DB before signing')
        await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
      }

      // Save the queue to file
      saveQueueToFile(ourParty.idx)
      
      // Check memory usage after successful transaction
      checkPostTransactionMemory(validTx.txId, 'transaction-success')
      
      // Force cleanup after successful transaction processing
      if (global.gc) {
        global.gc()
      }
    } catch (error: any) {
      if (error.message === 'signing-timeout') {
        // Handle the "'signing-timeout'" error - [TODO] - this is a replacer placeholder for now
        // Keep this tx in local processing until local DB finalizes it (observer will mark it COMPLETED).
        console.log('Transaction already signed by enough parties, waiting for local DB final status:', validTx.txId)

        let finalStatus: TransactionStatus.COMPLETED | TransactionStatus.FAILED | TransactionStatus.REVERTED
        try {
          finalStatus = await waitForLocalDBFinalStatus(validTx.txId, FINAL_STATUS_TIMEOUT_MS)
        } catch (waitError) {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
          appendToFailedTxsLogs(validTx, 'timeout waiting for local DB final status after enough-party')
          console.warn(`[wait-final] Timed out waiting for final status for ${validTx.txId}`)
        }

        if (finalStatus === TransactionStatus.COMPLETED) {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
          removeFromPendingTxQueue(txId)
          await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
          console.log(`[wait-final] ${validTx.txId} finalized as COMPLETED in local DB`)
        } else if (finalStatus === TransactionStatus.REVERTED) {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'reverted' })
          removeFromPendingTxQueue(txId)
          appendToFailedTxsLogs(validTx, 'reverted on-chain after enough-party')
          await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
          console.warn(`[wait-final] ${validTx.txId} finalized as REVERTED in local DB`)
        } else if (finalStatus === TransactionStatus.FAILED) {
          removeFromPendingTxQueue(txId)
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
          appendToFailedTxsLogs(validTx, 'finalized as failed in local DB after enough-party')
          console.warn(`[wait-final] ${validTx.txId} finalized as FAILED in local DB`)
        } else {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
          appendToFailedTxsLogs(validTx, 'did not finalize in local DB after enough-party')
          console.error(`[wait-final] ${validTx.txId} did not finalize in local DB after enough-party`)
        }
        // Additional cleanup for "enough party" scenarios to prevent memory leaks
        console.log('🧹 Performing cleanup after "enough party" wait')
        checkPostTransactionMemory(validTx.txId, 'enough-party-wait-final')
        if (global.gc) {
          global.gc()
        }
      } else if (error.message === 'Transaction processing timed out') {
        // Handle timeout errors more gracefully
        console.warn('⏱️ Transaction timed out, marking as failed and cleaning up:', validTx.txId)
        checkPostTransactionMemory(validTx.txId, 'timeout-error')
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        appendToFailedTxsLogs(validTx, 'timeout')
        
        // Force cleanup after timeout
        if (global.gc) {
          global.gc()
        }
      } else {
        // Handle other errors
        console.error('❌ Error processing transaction:', error)
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        appendToFailedTxsLogs(validTx, error.message ?? 'unknown')
        
        // Force cleanup after any error
        if (global.gc) {
          global.gc()
        }
      }
      saveQueueToFile(ourParty.idx)
      console.error('Error processing transaction:', error)
      // console.log("Transaction re-added to queue:", validTx);
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
      saveQueueToFile(ourParty.idx)

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
