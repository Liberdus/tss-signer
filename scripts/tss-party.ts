import {ethers} from 'ethers'
import * as fs from 'fs'
import {writeFile} from 'fs/promises'
import * as path from 'path'
import axios, {AxiosResponse} from 'axios'
import http from 'http'
import https from 'https'
import * as crypto from '@shardus/crypto-utils'
import * as readline from 'readline-sync'
import {toEthereumAddress, toShardusAddress} from './transformAddress'
import {isNormalizedTxId, normalizeTxId} from './transformTxId'
import * as rpcUrls from './lib/rpcUrls'
import {getHttpProviderForChain} from './lib/httpProviderHelper'

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

const gg18 = require('../pkg')
const {stringify, parse} = require('../external/stringify-shardus')

interface Params {
  threshold: number
  parties: number
}

interface ChainConfig {
  name: string
  chainId: number
  rpcUrl: string
  contractAddress: string
  tssSenderAddress?: string
  bridgeAddress?: string
  gasConfig?: {
    gasLimit: number
    gasPriceTiers: number[]
  }
  deploymentBlock: number // Block number when the contract was deployed (used as starting point for historical scan)
}

interface ChainConfigs {
  supportedChains: Record<string, ChainConfig>
  vaultChain?: ChainConfig      // Vault source chain config (used when enableLiberdusNetwork=false)
  secondaryChainConfig?: ChainConfig // Vault destination chain config (used when enableLiberdusNetwork=false)
  enableShardusCryptoAuth?: boolean
  enableLiberdusNetwork: boolean
  liberdusNetworkId: string
  coordinatorUrl?: string // Coordinator server URL (default: http://127.0.0.1:8000)
  collectorHost?: string // Collector server URL (default: http://127.0.0.1:3035)
  proxyServerHost?: string // Proxy server URL (default: http://127.0.0.1:3030)
}

interface ChainProviders {
  provider: ethers.providers.JsonRpcProvider
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
  txTimestamp?: number // Optional: populated when sourced from coordinator, used for queue ordering
}

interface TxQueueEntry {
  txTimestamp: number // milliseconds, from coordinator (blockchain time * 1000)
  status: 'pending' | 'processing' | 'completed' | 'failed'
}

interface KeyShare {
  idx: number
  res: string
  chainId?: number // Add chainId to identify which chain this keystore is for
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

type ProcessOutcome = 'completed' | 'failed' | 'skipped_coordinator_completed' | 'skipped_coordinator_failed'

// Transaction interface saved in the coordinator
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

interface TxStatusData
  extends Omit<
    Transaction,
    | "sender"
    | "value"
    | "type"
    | "txTimestamp"
    | "chainId"
    | "createdAt"
    | "updatedAt"
  > {
  party: number;
}

export enum TransactionStatus {
  PENDING = 0,
  PROCESSING = 1,
  COMPLETED = 2,
  FAILED = 3,
}

export enum TransactionType {
  BRIDGE_IN = 0,    // COIN to TOKEN (Liberdus → EVM)
  BRIDGE_OUT = 1,   // TOKEN to COIN (EVM → Liberdus)
  BRIDGE_VAULT = 2, // VAULT to SECONDARY (vault chain → secondary EVM chain)
}

const parsedIdx = process.argv[2]
const operationFlag = process.argv[3]
const recoveryTimestamp = process.argv[4] // Optional timestamp for emergency recovery

const generateKeystore = operationFlag === '--keygen'
const verifyKeystores = operationFlag === '--verify'
const recoverFromBackup = operationFlag === '--recover'
const verboseLogs = true
// When true, transactions older than TX_CLEANUP_MAX_AGE (24h) received from the
// coordinator are archived to the data store and failed-tx log and skipped instead
// of being queued.  Matches the txQueue eviction logic.
const rejectOldTransactions = true

const serverStartTime = Date.now()

let params: Params = loadParams()
let chainConfigs: ChainConfigs = loadChainConfigs()

// Vault mode: require vaultChain and secondaryChainConfig with distinct chainIds
if (!chainConfigs.enableLiberdusNetwork) {
  if (!chainConfigs.vaultChain || !chainConfigs.secondaryChainConfig) {
    console.error('vaultChain and secondaryChainConfig are required when enableLiberdusNetwork is false')
    process.exit(1)
  }
  if (chainConfigs.vaultChain.chainId === chainConfigs.secondaryChainConfig.chainId) {
    console.error('vaultChain and secondaryChainConfig must have different chainIds')
    process.exit(1)
  }
}

// All chains except vaultChain must have tssSenderAddress, bridgeAddress, and gasConfig
function requireFullChainConfig(config: ChainConfig, label: string): void {
  if (!config.tssSenderAddress || !config.bridgeAddress || !config.gasConfig) {
    console.error(`${label} (chainId ${config.chainId}) is missing tssSenderAddress, bridgeAddress, or gasConfig`)
    process.exit(1)
  }
}
if (chainConfigs.enableLiberdusNetwork) {
  for (const [chainId, config] of Object.entries(chainConfigs.supportedChains)) {
    requireFullChainConfig(config, `supportedChains[${chainId}]`)
  }
} else {
  requireFullChainConfig(chainConfigs.secondaryChainConfig!, 'secondaryChainConfig')
}

let t = params.threshold
let n = params.parties

const SIGN_ROUND_TIMEOUT_MS = 60_000 // 1 minute (must match Rust ROUND_TIMEOUT_MS)
const SIGN_POLL_DELAY_MS = 100

function signRound<T>(promise: Promise<T>, round: number | string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Sign round ${round} timed out after ${SIGN_ROUND_TIMEOUT_MS / 1000}s — not enough parties`)),
        SIGN_ROUND_TIMEOUT_MS,
      )
    ),
  ])
}

// Unified BridgedOut event ABI (all contracts use this 5-param signature)
// Shared bridge contract ABI for state reads and bridgeIn
const BRIDGE_CONTRACT_ABI = [
  'function bridgeInCooldown() view returns (uint256)',
  'function maxBridgeInAmount() view returns (uint256)',
  'function lastBridgeInTime() view returns (uint256)',
  'function bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId) public',
]
const BRIDGE_CONTRACT_IFACE = new ethersUtils.Interface(BRIDGE_CONTRACT_ABI)

// Unified BridgedOut event ABI (all contracts use this 5-param signature)
const BRIDGE_OUT_EVENT_ABI =
  'event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)'
const BRIDGE_OUT_IFACE = new ethersUtils.Interface([BRIDGE_OUT_EVENT_ABI])

/** Returns chain IDs active in the current mode (vault mode or Liberdus mode) */
function getEffectiveChainIds(): number[] {
  if (chainConfigs.enableLiberdusNetwork) {
    return Object.keys(chainConfigs.supportedChains).map(Number)
  }
  return [chainConfigs.secondaryChainConfig!.chainId]
}

/** Looks up a ChainConfig by chainId across vaultChain, secondaryChainConfig, and supportedChains */
function getChainConfigById(chainId: number): ChainConfig | undefined {
  if (chainConfigs.vaultChain?.chainId === chainId) return chainConfigs.vaultChain
  if (chainConfigs.secondaryChainConfig?.chainId === chainId) return chainConfigs.secondaryChainConfig
  return chainConfigs.supportedChains[chainId.toString()]
}

const coordinatorUrl = process.env.COORDINATOR_URL || chainConfigs.coordinatorUrl;
const collectorHost = process.env.COLLECTOR_HOST || chainConfigs.collectorHost;
const proxyServerHost = process.env.PROXY_SERVER_HOST || chainConfigs.proxyServerHost;

const tssPartyIdx =
  parsedIdx == null ? readline.question('Enter the party index (1 to 5): ') : parsedIdx
const ourParty: KeyShare = {idx: parseInt(tssPartyIdx), res: ''}

// In vault mode use [vaultChain, secondaryChainConfig]; in Liberdus mode use supportedChains
const chainsToInit: ChainConfig[] = chainConfigs.enableLiberdusNetwork
  ? Object.values(chainConfigs.supportedChains)
  : [chainConfigs.vaultChain!, chainConfigs.secondaryChainConfig!]

const rpcConfigByChainId: Record<string, {rpcUrl: string}> = {}
for (const config of chainsToInit) {
  rpcConfigByChainId[config.chainId.toString()] = {
    rpcUrl: config.rpcUrl,
  }
}
rpcUrls.initFromConfig(rpcConfigByChainId)
rpcUrls.startHourlyChainlistFetch(chainsToInit.map((c) => c.chainId))

// Initialize providers for all supported chains
const chainProviders: Map<number, ChainProviders> = new Map()

for (const config of chainsToInit) {
  const chainId = config.chainId
  const fallbackRpcUrl = config.rpcUrl

  const provider = getHttpProviderForChain(rpcUrls.getHttpUrls(chainId), {
    fallbackRpcUrl,
    chainId,
  })

  chainProviders.set(chainId, {
    provider,
    config,
    bridgeInCooldown: 0,
    maxBridgeInAmount: ethers.BigNumber.from(0),
    lastBridgeInTime: 0,
  })

  console.log(`HTTP provider initialized for ${config.name} (Chain ID: ${chainId})`)
}

type FetchBridgeStateFields = 'all' | 'bridgeInCooldown' | 'maxBridgeInAmount' | 'lastBridgeInTime'

// Fetch bridge contract state for a chain. Pass fields to limit which values are fetched.
async function fetchBridgeState(chainId: number, fields: FetchBridgeStateFields = 'all'): Promise<void> {
  const chainProvider = chainProviders.get(chainId)
  if (!chainProvider) return

  const contractAddr = chainProvider.config.contractAddress
  try {
    if (fields === 'all') {
      const [cooldownRaw, maxAmountRaw, lastTimeRaw] = await Promise.all([
        chainProvider.provider.call({ to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('bridgeInCooldown') }),
        chainProvider.provider.call({ to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('maxBridgeInAmount') }),
        chainProvider.provider.call({ to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('lastBridgeInTime') }),
      ])
      chainProvider.bridgeInCooldown = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('bridgeInCooldown', cooldownRaw)[0].toNumber()
      chainProvider.maxBridgeInAmount = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('maxBridgeInAmount', maxAmountRaw)[0]
      chainProvider.lastBridgeInTime = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('lastBridgeInTime', lastTimeRaw)[0].toNumber()
      const lastBridgeInStr = chainProvider.lastBridgeInTime > 0
        ? new Date(chainProvider.lastBridgeInTime * 1000).toISOString()
        : 'never'
      const maxAmountStr = chainProvider.maxBridgeInAmount.isZero()
        ? 'unlimited'
        : `${ethersUtils.formatEther(chainProvider.maxBridgeInAmount)} ETH`
      console.log(
        `Bridge state fetched for ${chainProvider.config.name}: ` +
        `cooldown=${chainProvider.bridgeInCooldown}s, ` +
        `maxBridgeInAmount=${maxAmountStr}, ` +
        `lastBridgeInTime=${lastBridgeInStr}`
      )
    } else if (fields === 'lastBridgeInTime') {
      const lastTimeRaw = await chainProvider.provider.call({ to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('lastBridgeInTime') })
      chainProvider.lastBridgeInTime = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('lastBridgeInTime', lastTimeRaw)[0].toNumber()
      const lastBridgeInStr = chainProvider.lastBridgeInTime > 0
        ? new Date(chainProvider.lastBridgeInTime * 1000).toISOString()
        : 'never'
      console.log(`Bridge lastBridgeInTime fetched for ${chainProvider.config.name}: ${lastBridgeInStr}`)
    } else if (fields === 'bridgeInCooldown') {
      const cooldownRaw = await chainProvider.provider.call({ to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('bridgeInCooldown') })
      chainProvider.bridgeInCooldown = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('bridgeInCooldown', cooldownRaw)[0].toNumber()
      console.log(`Bridge bridgeInCooldown fetched for ${chainProvider.config.name}: ${chainProvider.bridgeInCooldown}s`)
    } else if (fields === 'maxBridgeInAmount') {
      const maxAmountRaw = await chainProvider.provider.call({ to: contractAddr, data: BRIDGE_CONTRACT_IFACE.encodeFunctionData('maxBridgeInAmount') })
      chainProvider.maxBridgeInAmount = BRIDGE_CONTRACT_IFACE.decodeFunctionResult('maxBridgeInAmount', maxAmountRaw)[0]
      const maxAmountStr = chainProvider.maxBridgeInAmount.isZero()
        ? 'unlimited'
        : `${ethersUtils.formatEther(chainProvider.maxBridgeInAmount)} ETH`
      console.log(`Bridge maxBridgeInAmount fetched for ${chainProvider.config.name}: ${maxAmountStr}`)
    }
  } catch (error) {
    console.warn(`Failed to fetch bridge state for chain ${chainId}:`, error)
  }
}

async function waitForBridgeCooldown(chainProvider: ChainProviders, chainName: string): Promise<void> {
  if (chainProvider.bridgeInCooldown <= 0 || chainProvider.lastBridgeInTime <= 0) return
  const latestBlock = await chainProvider.provider.getBlock('latest')
  const now = latestBlock.timestamp
  const cooldownEnd = chainProvider.lastBridgeInTime + chainProvider.bridgeInCooldown
  if (now < cooldownEnd) {
    const waitSec = cooldownEnd - now
    console.log(
      `Waiting ${waitSec}s for bridge-in cooldown on ${chainName}: ` +
      `lastBridgeInTime=${new Date(chainProvider.lastBridgeInTime * 1000).toISOString()}, ` +
      `cooldown=${chainProvider.bridgeInCooldown}s, ` +
      `cooldownEnd=${new Date(cooldownEnd * 1000).toISOString()}, ` +
      `chainNow=${new Date(now * 1000).toISOString()}`
    )
    await sleep(waitSec * 1000)
  }
}

function checkMaxBridgeAmount(
  chainProvider: ChainProviders,
  value: ethers.BigNumber,
  txId: string,
  chainName: string,
): boolean {
  if (chainProvider.maxBridgeInAmount.isZero()) return true
  if (value.lte(chainProvider.maxBridgeInAmount)) return true
  const reason = `Amount ${ethersUtils.formatEther(value)} exceeds bridge-in limit ${ethersUtils.formatEther(chainProvider.maxBridgeInAmount)} on ${chainName}`
  console.error(reason)
  sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, '', reason)
  return false
}

async function refreshBridgeStateOnRevert(reason: string | undefined, chainId: number): Promise<void> {
  if (!reason || (!reason.includes('Bridge-in cooldown not met') && !reason.includes('Amount exceeds bridge-in limit'))) return
  console.log(`Refreshing bridge state for chain ${chainId} due to revert: ${reason}`)
  await fetchBridgeState(chainId)
}

// Fetch bridge state for all chains on startup (skip vault source chain — we only call bridgeIn on the destination)
for (const [chainId] of chainProviders.entries()) {
  if (!chainConfigs.enableLiberdusNetwork && chainId === chainConfigs.vaultChain!.chainId) continue
  console.log(`Fetching bridge state for chain ${chainId}`)
  fetchBridgeState(chainId).catch((err) =>
    console.warn(`Failed to fetch bridge state for chain ${chainId}:`, err)
  )
}

const cryptoInitKey = process.env.SHARDUS_CRYPTO_HASH_KEY || '69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc'
crypto.init(cryptoInitKey)
crypto.setCustomStringifier(stringify, 'shardus_safeStringify')

const enableShardusCryptoAuth =
  process.env.ENABLE_SHARDUS_CRYPTO_AUTH != null
    ? process.env.ENABLE_SHARDUS_CRYPTO_AUTH === 'true'
    : chainConfigs.enableShardusCryptoAuth === true
const signerKeyStoreDir = path.join(__dirname, '../keystores')
const signerKeyPairFilePathFromEnv = (process.env.TSS_SIGNER_KEYPAIR_FILE || '').trim()

type SignerKeyPair = {
  publicKey: string
  secretKey: string
}

function isHexWithLength(value: string, length: number): boolean {
  return value.length === length && /^[0-9a-fA-F]+$/.test(value)
}

function loadSignerKeyPairFromFile(filePath: string): SignerKeyPair | null {
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SignerKeyPair
    const publicKey = typeof parsed.publicKey === 'string' ? parsed.publicKey.trim() : ''
    const secretKey = typeof parsed.secretKey === 'string' ? parsed.secretKey.trim() : ''
    if (
      isHexWithLength(publicKey, 64) &&
      isHexWithLength(secretKey, 128)
    ) {
      return {
        publicKey,
        secretKey,
      }
    }
    console.error(
      `[auth] Invalid signer keyPair format in ${filePath}: expected publicKey=64 hex and secretKey=128 hex`
    )
  } catch (error) {
    console.error(`[auth] Failed to read signer keyPair file ${filePath}:`, error)
  }
  return null
}

function resolveSignerKeyPairFilePath(partyIdx: number): string {
  if (signerKeyPairFilePathFromEnv) return signerKeyPairFilePathFromEnv
  return path.join(signerKeyStoreDir, `tss_signer_keypair_party_${partyIdx}.json`)
}

function ensureSignerKeyPairTemplate(filePath: string): void {
  if (fs.existsSync(filePath)) return
  fs.mkdirSync(path.dirname(filePath), {recursive: true})
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        publicKey: '',
        secretKey: '',
      },
      null,
      2
    ) + '\n'
  )
  console.warn(`[auth] Created missing signer keyPair template at ${filePath}`)
}

let signerPublicKey = ''
let signerSecretKey = ''

if (enableShardusCryptoAuth) {
  if (typeof gg18.gg18_shardus_crypto_init !== 'function' || typeof gg18.gg18_shardus_crypto_keys !== 'function') {
    throw new Error(
      '[auth] ENABLE_SHARDUS_CRYPTO_AUTH is true but gg18 Shardus Crypto exports are unavailable'
    )
  }

  const shardusCryptoHashKey = cryptoInitKey
  if (!shardusCryptoHashKey) {
    throw new Error(
      '[auth] SHARDUS_CRYPTO_HASH_KEY is required when ENABLE_SHARDUS_CRYPTO_AUTH=true'
    )
  }

  const signerKeyPairFilePath = resolveSignerKeyPairFilePath(ourParty.idx)
  const fileKeyPair = loadSignerKeyPairFromFile(signerKeyPairFilePath)
  signerPublicKey =
    (process.env.TSS_SIGNER_PUB_KEY || '').trim() || fileKeyPair?.publicKey || ''
  signerSecretKey =
    (process.env.TSS_SIGNER_SEC_KEY || '').trim() || fileKeyPair?.secretKey || ''

  if (!signerPublicKey || !signerSecretKey) {
    if (!signerKeyPairFilePathFromEnv) {
      ensureSignerKeyPairTemplate(signerKeyPairFilePath)
    }
    throw new Error(
      `[auth] TSS signer keyPair is required when ENABLE_SHARDUS_CRYPTO_AUTH=true (set TSS_SIGNER_PUB_KEY/TSS_SIGNER_SEC_KEY or fill ${signerKeyPairFilePath})`
    )
  }
  if (!isHexWithLength(signerPublicKey, 64) || !isHexWithLength(signerSecretKey, 128)) {
    throw new Error(
      '[auth] Invalid TSS signer keyPair format: expected TSS_SIGNER_PUB_KEY=64 hex and TSS_SIGNER_SEC_KEY=128 hex'
    )
  }

  gg18.gg18_shardus_crypto_init(shardusCryptoHashKey)
  gg18.gg18_shardus_crypto_keys(signerPublicKey, signerSecretKey)
  console.log('[auth] gg18 Shardus Crypto request signing enabled for coordinator calls')
} else {
  console.log('[auth] gg18 Shardus Crypto request signing disabled (local development mode)')
}

function buildSignedCoordinatorRequest(payload: unknown): unknown {
  if (!enableShardusCryptoAuth) return payload
  const obj: any = { payload, ts: Date.now() }
  crypto.signObj(obj, signerSecretKey, signerPublicKey)
  return obj
}

const KEYSTORE_DIR = path.join(__dirname, '../keystores')

// enough party subscribed error
const enoughPartyError = 'Enough party already registerd to sign this transaction'

if (!fs.existsSync(KEYSTORE_DIR)) {
  fs.mkdirSync(KEYSTORE_DIR, {recursive: true})
}

const pendingTxQueue: TransactionQueueItem[] = []
const txQueueMap: Map<string, TxQueueEntry> = new Map()
const txQueueProcessingInterval = 10000
const COORDINATOR_POLL_INTERVAL = 10 * 1000 // 10s
const COORDINATOR_FINAL_STATUS_POLL_INTERVAL = 3 * 1000 // 3s
const TX_PROCESSING_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes ( Including the bridgeInCooldown 1-minute)

const TX_CLEANUP_MAX_AGE = 24 * 60 * 60 * 1000 // 24 hours for all statuses

const TX_DATA_STORE_MAX_ENTRIES = 500
const TX_DATA_STORE_MAX_FILES = 5
// Compiled once at startup; ourParty.idx is known at module-init time
const TX_DATA_STORE_FILE_PATTERN = new RegExp(`^tx_data_store_${ourParty.idx}_\\d+\\.json$`)
// Tracks the active tx_data_store file path in memory to avoid readdirSync on every append
let txDataStoreCurrentFile: string | null = null

// Define maximum concurrent transactions
const MAX_CONCURRENT_TXS = 1
const processingTransactionIds = new Map<string, TransactionQueueItem>()

const delay_ms = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))


// Global HTTP agents with keep-alive enabled.
// keepAlive:      reuse sockets across requests and lets the OS send TCP probes
//                 on idle connections — detects a dead coordinator faster than
//                 waiting for the axios timeout (critical for network partitions).
// keepAliveMsecs: initial delay before the OS starts probing (30 s is standard).
// maxSockets:     cap concurrent connections per host; TSS party traffic is low
//                 (periodic coordinator polls + occasional status POSTs) so 10 is ample.
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

function loadParams(): Params {
  const data = fs.readFileSync(path.join(__dirname, '../', 'params.json'), 'utf8')
  return JSON.parse(data)
}

function loadChainConfigs(): ChainConfigs {
  const data = fs.readFileSync(path.join(__dirname, '../', 'chain-config.json'), 'utf8')
  return JSON.parse(data)
}

const getKeystoreFilePath = (partyIdx: number, chainId?: number): string => {
  if (chainId) {
    return path.join(KEYSTORE_DIR, `keystore_party_${partyIdx}_chain_${chainId}.json`)
  }
  // Legacy path for backward compatibility
  return path.join(KEYSTORE_DIR, `keystore_party_${partyIdx}.json`)
}

const keystoreExists = (partyIdx: number, chainId?: number): boolean => {
  return fs.existsSync(getKeystoreFilePath(partyIdx, chainId))
}

const saveKeystore = (partyIdx: number, keystore: string, chainId?: number): void => {
  const filePath = getKeystoreFilePath(partyIdx, chainId)
  fs.writeFileSync(filePath, keystore)
  if (chainId) {
    console.log(`Keystore for party ${partyIdx} chain ${chainId} saved to ${filePath}`)
  } else {
    console.log(`Keystore for party ${partyIdx} saved to ${filePath}`)
  }
}

const loadKeystore = (partyIdx: number, chainId?: number): string => {
  return fs.readFileSync(getKeystoreFilePath(partyIdx, chainId), 'utf8')
}

// New function to get all available chain keystores for a party
const getAvailableChainKeystores = (partyIdx: number): number[] => {
  const chainIds: number[] = []

  // Check for chain-specific keystores
  for (const chainId of getEffectiveChainIds()) {
    if (keystoreExists(partyIdx, chainId)) {
      chainIds.push(chainId)
    }
  }

  return chainIds
}

// New function to ensure all chain keystores exist for a party
const ensureChainKeystores = async (partyIdx: number): Promise<Map<number, string>> => {
  const keystores = new Map<number, string>()

  for (const chainId of getEffectiveChainIds()) {

    if (keystoreExists(partyIdx, chainId)) {
      // Load existing keystore
      keystores.set(chainId, loadKeystore(partyIdx, chainId))
      console.log(`Loaded existing keystore for party ${partyIdx} chain ${chainId}`)
    } else {
      // Generate new keystore for this chain
      console.log(`Generating new keystore for party ${partyIdx} chain ${chainId}`)
      const delay = SIGN_POLL_DELAY_MS
      // Create deterministic operation ID based on chain ID and a fixed identifier
      const operationId = `keygen-chain-${chainId}`

      try {
        const newKeystore = await keygen(gg18, delay, operationId)
        saveKeystore(partyIdx, newKeystore, chainId)
        keystores.set(chainId, newKeystore)
        console.log(`Generated new keystore for party ${partyIdx} chain ${chainId}`)
      } catch (e) {
        console.error(`Failed to generate keystore for party ${partyIdx} chain ${chainId}:`, e)
        throw e
      }
    }
  }

  return keystores
}

// New function to get keystore for a specific chain
const getKeystoreForChain = (partyIdx: number, chainId: number): string => {
  if (keystoreExists(partyIdx, chainId)) {
    return loadKeystore(partyIdx, chainId)
  }

  // Fallback to legacy keystore if chain-specific doesn't exist
  if (keystoreExists(partyIdx)) {
    console.warn(`Using legacy keystore for party ${partyIdx} chain ${chainId}`)
    return loadKeystore(partyIdx)
  }

  throw new Error(`No keystore found for party ${partyIdx} chain ${chainId}`)
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

    // Restore txQueueMap.
    // Any entry that was 'processing' at save time is orphaned on restart
    // (processingTransactionIds is in-memory and starts empty).  Reset those
    // to 'failed' so the coordinator poll re-queues them on the next cycle.
    if (Array.isArray(data.map)) {
      for (const [txId, entry] of data.map as [string, TxQueueEntry][]) {
        if (entry.status === 'processing') {
          entry.status = 'failed'
          console.warn(`[loadQueue] Resetting orphaned processing tx to failed: ${txId}`)
        }
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
      }
    }

    // Single read: get file contents and check entry count in one pass
    let fileData: { createdAt: number; entries: object[] } | null = null
    if (txDataStoreCurrentFile) {
      fileData = JSON.parse(fs.readFileSync(txDataStoreCurrentFile, 'utf8'))
    }

    if (!fileData || fileData.entries.length >= TX_DATA_STORE_MAX_ENTRIES) {
      // Roll to a new file; scan once here to prune oldest if over the limit
      const allFiles = fs.readdirSync(KEYSTORE_DIR)
        .filter(f => TX_DATA_STORE_FILE_PATTERN.test(f))
        .sort()
      while (allFiles.length >= TX_DATA_STORE_MAX_FILES) {
        fs.unlinkSync(path.join(KEYSTORE_DIR, allFiles.shift()!))
      }
      txDataStoreCurrentFile = path.join(KEYSTORE_DIR, `tx_data_store_${ourParty.idx}_${Date.now()}.json`)
      fileData = { createdAt: Date.now(), entries: [] }
    }

    fileData.entries.push({
      txId: txData.txId,
      from: txData.from,
      value: txData.value.toString(),
      type: txData.type,
      chainId: txData.chainId,
      txTimestamp: txData.txTimestamp,
      addedAt: Date.now(),
    })
    fs.writeFileSync(txDataStoreCurrentFile, JSON.stringify(fileData))
  } catch (err) {
    console.error('[txDataStore] Failed to append tx data:', err)
  }
}

function appendToFailedTxsLogs(txData: TransactionQueueItem, error: string): void {
  try {
    const filePath = path.join(KEYSTORE_DIR, `failed_txs_logs_party_${ourParty.idx}.json`)
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

function findInTxDataStoreFiles(txId: string): TransactionQueueItem | null {
  try {
    const files = fs.readdirSync(KEYSTORE_DIR)
      .filter(f => TX_DATA_STORE_FILE_PATTERN.test(f))
      .sort()
      .reverse() // most recent first

    for (const file of files) {
      const fileData = JSON.parse(fs.readFileSync(path.join(KEYSTORE_DIR, file), 'utf8'))
      const entry = fileData.entries?.find((e: any) => e.txId === txId)
      if (entry) {
        return {
          receipt: null as any,
          from: entry.from,
          value: ethers.BigNumber.from(entry.value),
          txId: entry.txId,
          type: entry.type,
          chainId: entry.chainId,
          txTimestamp: entry.txTimestamp,
        }
      }
    }
  } catch (err) {
    console.error(`[txDataStore] Failed to search for tx ${txId}:`, err)
  }
  return null
}

// Function to recover from emergency backup if needed
const recoverFromEmergencyBackup = (partyIdx: number, backupTimestamp?: number): boolean => {
  try {
    // Find the most recent emergency backup if no timestamp provided
    const backupFiles = fs.readdirSync(KEYSTORE_DIR)
      .filter(file => file.startsWith(`emergency_backup_party_${partyIdx}_`) && file.endsWith('.json'))
      .sort((a, b) => {
        const timestampA = parseInt(a.match(/emergency_backup_party_\d+_(\d+)\.json$/)?.[1] || '0')
        const timestampB = parseInt(b.match(/emergency_backup_party_\d+_(\d+)\.json$/)?.[1] || '0')
        return timestampB - timestampA // Most recent first
      })
    
    if (backupFiles.length === 0) {
      console.log('❌ No emergency backup files found')
      return false
    }
    
    const backupFile = backupTimestamp 
      ? `emergency_backup_party_${partyIdx}_${backupTimestamp}.json`
      : backupFiles[0]
    
    const backupPath = path.join(KEYSTORE_DIR, backupFile)
    
    if (!fs.existsSync(backupPath)) {
      console.log(`❌ Emergency backup file not found: ${backupPath}`)
      return false
    }
    
    const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    
    console.log(`💾 Recovering from emergency backup: ${backupFile}`)
    console.log(`📊 Backup info: ${backupData.reason}, original size: ${backupData.originalSize}`)
    
    // Clear current queue and load from backup
    pendingTxQueue.length = 0
    txQueueMap.clear()
    processingTransactionIds.clear()

    if (Array.isArray(backupData.pending)) {
      for (const tx of backupData.pending) {
        pendingTxQueue.push({ ...tx, value: ethers.BigNumber.from(tx.value?.hex ?? tx.value ?? '0') })
      }
    }
    if (Array.isArray(backupData.map)) {
      for (const [txId, entry] of backupData.map as [string, any][]) {
        txQueueMap.set(txId, {
          txTimestamp: entry.txTimestamp ?? entry.timestamp ?? Date.now(),
          status: entry.status ?? 'pending',
        })
      }
    }

    console.log(`✅ Successfully recovered ${txQueueMap.size} transactions from emergency backup`)
    
    // Save the recovered state as the current queue
    saveQueueToFile(partyIdx)
    
    return true
  } catch (error) {
    console.error('❌ Failed to recover from emergency backup:', error)
    return false
  }
}

// Extract EOA address and public key from keystore without requiring TSS coordination
const extractPublicKeyFromKeystore = (keystoreJson: string): { publicKey: string; address: string } => {
  try {
    const keystore = JSON.parse(keystoreJson)
    
    // The public key is stored in the keystore at index 5
    // and it's in the format {x: "hex", y: "hex"}
    const publicKeyData = keystore[5]
    if (!publicKeyData || !publicKeyData.x || !publicKeyData.y) {
      throw new Error('Invalid keystore structure: public key not found at index 5')
    }
    
    let publicKeyX = publicKeyData.x
    let publicKeyY = publicKeyData.y
    
    // Ensure even length hex strings
    if (publicKeyX.length % 2 !== 0) publicKeyX = '0' + publicKeyX
    if (publicKeyY.length % 2 !== 0) publicKeyY = '0' + publicKeyY
    
    // Convert the uncompressed public key to the format expected by ethers
    // Ethereum uses uncompressed public keys: 0x04 + x + y
    const uncompressedPublicKey = '0x04' + publicKeyX + publicKeyY
    
    // Compute the Ethereum address from the public key
    const address = ethersUtils.computeAddress(uncompressedPublicKey)
    
    return {
      publicKey: uncompressedPublicKey,
      address: address
    }
  } catch (error) {
    console.error('Failed to extract public key from keystore:', error)
    throw error
  }
}

// Generate public key file from keystore
const generatePublicKeyFile = (partyIdx: number, chainId: number): void => {
  try {
    const keystore = getKeystoreForChain(partyIdx, chainId)
    const { publicKey, address } = extractPublicKeyFromKeystore(keystore)
    const chainConfig = getChainConfigById(chainId)
    const chainName = chainConfig?.name || `Chain ${chainId}`
    
    const publicKeyFilePath = path.join(KEYSTORE_DIR, `public_key_party_${partyIdx}_chain_${chainId}.json`)
    const publicKeyData = {
      chainId,
      chainName,
      publicKey: publicKey,
      address: address,
      generated: new Date().toISOString()
    }
    fs.writeFileSync(publicKeyFilePath, JSON.stringify(publicKeyData, null, 2))
    console.log(`📄 Generated public key file for ${chainName}: ${publicKeyFilePath}`)
  } catch (error) {
    console.error(`Failed to generate public key file for party ${partyIdx} chain ${chainId}:`, error)
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

async function keygen(m: any, delay: number, operationId?: string): Promise<string> {
  const keygenOperationId = operationId || cryptoInitKey.slice(2, 8)
  let context = await m.gg18_keygen_client_new_context(
    coordinatorUrl,
    t,
    n,
    delay,
    keygenOperationId,
  )
  console.log('Keygen context created:', context)
  context = await m.gg18_keygen_client_round1(context, delay)
  context = await m.gg18_keygen_client_round2(context, delay)
  context = await m.gg18_keygen_client_round3(context, delay)
  context = await m.gg18_keygen_client_round4(context, delay)
  const keygen_json = await m.gg18_keygen_client_round5(context, delay)
  return keygen_json
}

async function sign(m: any, key_store: string, delay: number, digest: string): Promise<string> {
  const operationId = digest.slice(2, 8)
  console.log('Signing digest:', digest)
  console.log('Operation ID:', operationId)
  console.log('Sign delay(ms):', delay, 'Sign round timeout(ms):', SIGN_ROUND_TIMEOUT_MS)
  
  let context = null
  try {
    context = await signRound(
      m.gg18_sign_client_new_context(coordinatorUrl, t, n, key_store, digest.slice(2), operationId),
      'new_context',
    )
    let contextJSON = JSON.parse(context)
    if (contextJSON.party_num_int > t + 1) {
      console.log('Party number is greater than threshold + 1, returning')
      throw new Error(enoughPartyError)
    }
    console.log('our party number', contextJSON.party_num_int)

    console.log('sign round', 0)
    context = await signRound(m.gg18_sign_client_round0(context, delay), 0)
    console.log('sign round', 1)
    context = await signRound(m.gg18_sign_client_round1(context, delay), 1)
    console.log('sign round', 2)
    context = await signRound(m.gg18_sign_client_round2(context, delay), 2)
    console.log('sign round', 3)
    context = await signRound(m.gg18_sign_client_round3(context, delay), 3)
    console.log('sign round', 4)
    context = await signRound(m.gg18_sign_client_round4(context, delay), 4)
    console.log('sign round', 5)
    context = await signRound(m.gg18_sign_client_round5(context, delay), 5)
    console.log('sign round', 6)
    context = await signRound(m.gg18_sign_client_round6(context, delay), 6)
    console.log('sign round', 7)
    context = await signRound(m.gg18_sign_client_round7(context, delay), 7)
    console.log('sign round', 8)
    context = await signRound(m.gg18_sign_client_round8(context, delay), 8)
    const sign_json = await signRound<string>(m.gg18_sign_client_round9(context, delay), 9)
    console.log('Signature:', sign_json)
    
    // Force cleanup after successful signing
    if (global.gc) {
      global.gc()
    }
    
    return sign_json
  } catch (error) {
    // Clean up any context or resources on error
    console.log('Error in sign function, cleaning up resources', error)
    if (context && m.gg18_cleanup_context) {
      try {
        await m.gg18_cleanup_context(context)
      } catch (cleanupError) {
        console.warn('Failed to cleanup signing context:', cleanupError)
      }
    }
    
    // Force garbage collection on error
    if (global.gc) {
      global.gc()
    }
    
    throw error
  }
}

async function sendTxStatusToCoordinator(
  txId: string,
  status: TransactionStatus,
  receiptId: string,
  failedReason = '',
): Promise<void> {
  try {
    const url = `${coordinatorUrl}/transaction/status`
    const data: TxStatusData = {
      txId: normalizeTxId(txId),
      status,
      receiptId: receiptId ? normalizeTxId(receiptId) : receiptId,
      reason: failedReason,
      party: ourParty.idx,
    }
    const response = await axios.post(url, buildSignedCoordinatorRequest(data))
    if (response.status !== 202 && response.status !== 200) {
      console.error('Failed to update transaction status to coordinator:', response.data)
      return
    }
    if (verboseLogs) {
      console.log('Updated transaction status to coordinator:', response.data)
    }
  } catch (error) {
    console.error('Error updating transaction status to coordinator:', error)
  }
}

/**
 * Verifies a BRIDGE_OUT or BRIDGE_VAULT transaction against the EVM receipt on
 * the source chain.  Checks receipt status, contract address, and BridgedOut
 * event fields (chainId, amount, targetAddress).
 */
async function validateTokenToCoin(tx: Transaction): Promise<boolean> {
  const chainProvider = chainProviders.get(tx.chainId)
  if (!chainProvider) {
    console.warn(`[validateTokenToCoin] No chain provider for chainId ${tx.chainId}, skipping tx ${tx.txId}`)
    return false
  }

  let receipt: ethers.providers.TransactionReceipt | null
  try {
    const txHash = tx.txId.startsWith('0x') ? tx.txId : '0x' + tx.txId
    receipt = await chainProvider.provider.getTransactionReceipt(txHash)
  } catch (err) {
    console.warn(`[validateTokenToCoin] Failed to fetch receipt for ${tx.txId}:`, err)
    return false
  }

  if (!receipt) {
    console.warn(`[validateTokenToCoin] Receipt not found for ${tx.txId}`)
    return false
  }
  if (receipt.status !== 1) {
    console.warn(`[validateTokenToCoin] tx ${tx.txId} receipt status is not 1 (got ${receipt.status})`)
    return false
  }

  const expectedContract = chainProvider.config.contractAddress.toLowerCase()
  if (receipt.to?.toLowerCase() !== expectedContract) {
    console.warn(`[validateTokenToCoin] tx ${tx.txId} recipient ${receipt.to} does not match bridge contract ${expectedContract}`)
    return false
  }

  const bridgeOutLog = receipt.logs.find((log) => {
    if (log.address.toLowerCase() !== expectedContract) return false
    try {
      return BRIDGE_OUT_IFACE.parseLog(log).name === 'BridgedOut'
    } catch {
      return false
    }
  })

  if (!bridgeOutLog) {
    console.warn(`[validateTokenToCoin] No BridgedOut event found in tx ${tx.txId}`)
    return false
  }

  const parsed = BRIDGE_OUT_IFACE.parseLog(bridgeOutLog)
  const eventChainId: number = (parsed.args.chainId as ethers.BigNumber).toNumber()
  const eventAmount: ethers.BigNumber = parsed.args.amount
  const eventTargetAddress: string = parsed.args.targetAddress

  if (eventChainId !== tx.chainId) {
    console.warn(`[validateTokenToCoin] chainId mismatch in ${tx.txId}: event=${eventChainId} stored=${tx.chainId}`)
    return false
  }

  const derivedSender = toEthereumAddress(eventTargetAddress).toLowerCase()
  if (derivedSender !== tx.sender.toLowerCase()) {
    console.warn(`[validateTokenToCoin] sender mismatch in ${tx.txId}: derived=${derivedSender} stored=${tx.sender.toLowerCase()}`)
    return false
  }

  const storedValue = ethers.BigNumber.from(tx.value)
  if (!eventAmount.eq(storedValue)) {
    console.warn(`[validateTokenToCoin] amount mismatch in ${tx.txId}: event=${eventAmount.toString()} stored=${storedValue.toString()}`)
    return false
  }

  return true
}

/**
 * Verifies a BRIDGE_IN transaction against the Liberdus receipt from the
 * collector API.  Checks that the tx succeeded, is a transfer, targets the
 * correct bridge address for the destination chain, and that amount / sender
 * match what the coordinator recorded.
 */
async function validateCoinToToken(tx: Transaction): Promise<boolean> {
  let receiptData: any
  try {
    const url = `${collectorHost}/api/transaction?txId=${encodeURIComponent(tx.txId)}`
    const response = await axios.get(url, {timeout: 10_000})
    receiptData = response.data
  } catch (err) {
    console.warn(`[validateCoinToToken] Failed to fetch Liberdus receipt for ${tx.txId}:`, err)
    return false
  }

  // Collector may wrap the result under `transactions[0]` or return it directly
  const receipt = receiptData?.transactions?.[0] ?? receiptData
  if (!receipt?.data) {
    console.warn(`[validateCoinToToken] No receipt data returned for ${tx.txId}`)
    return false
  }

  const {success, to, from, additionalInfo, type} = receipt.data

  if (!success) {
    console.warn(`[validateCoinToToken] Liberdus tx ${tx.txId} is not successful`)
    return false
  }
  if (type !== 'transfer') {
    console.warn(`[validateCoinToToken] Liberdus tx ${tx.txId} type is not transfer (got ${type})`)
    return false
  }

  // tx.chainId for BRIDGE_IN is the destination EVM chain — look up its bridgeAddress
  const chainConfig = chainConfigs.supportedChains[tx.chainId.toString()]
  if (!chainConfig) {
    console.warn(`[validateCoinToToken] No chain config for chainId ${tx.chainId}`)
    return false
  }
  if (to !== chainConfig.bridgeAddress) {
    console.warn(`[validateCoinToToken] tx ${tx.txId} destination ${to} does not match bridge address ${chainConfig.bridgeAddress}`)
    return false
  }

  const derivedSender = toEthereumAddress(from).toLowerCase()
  if (derivedSender !== tx.sender.toLowerCase()) {
    console.warn(`[validateCoinToToken] sender mismatch in ${tx.txId}: derived=${derivedSender} stored=${tx.sender.toLowerCase()}`)
    return false
  }

  const eventAmount = ethers.BigNumber.from('0x' + additionalInfo.amount.value)
  const storedValue = ethers.BigNumber.from(tx.value)
  if (!eventAmount.eq(storedValue)) {
    console.warn(`[validateCoinToToken] amount mismatch in ${tx.txId}: event=${eventAmount.toString()} stored=${storedValue.toString()}`)
    return false
  }

  return true
}

/** Dispatches to the appropriate validator based on transaction type. */
async function verifyCoordinatorTxData(tx: Transaction): Promise<boolean> {
  if (tx.type === TransactionType.BRIDGE_IN) return validateCoinToToken(tx)
  return validateTokenToCoin(tx)
}

async function pollPendingTransactionsFromCoordinator(): Promise<void> {
  console.log('Polling pending transactions from coordinator...', new Date().toISOString())
  try {
    const url = `${coordinatorUrl}/transaction?unprocessed=true`
    const response = await axios.get(url, {timeout: COORDINATOR_POLL_INTERVAL})
    const data = response.data
    if (verboseLogs) {
      console.log('Received pending transactions from coordinator:', data.Ok.transactions)
    }
    if (!data?.Ok?.transactions) return

    const transactions: Transaction[] = data.Ok.transactions
      .slice()
      .sort((a: Transaction, b: Transaction) => a.txTimestamp - b.txTimestamp)
    if (transactions.length === 0) return

    if (data.Ok.totalTranactions > transactions.length) {
      console.warn(
        `[poll] ${data.Ok.totalTranactions} pending txs on coordinator, only fetched ${transactions.length} (first page)`,
      )
    }

    for (const tx of transactions) {
      if (!tx.txId || !isNormalizedTxId(tx.txId)) {
        console.warn(`[poll] Skipping tx with invalid txId (expected 64 chars): ${tx.txId}`)
        continue
      }
      if (!tx.txTimestamp || !tx.sender || !tx.value || tx.chainId == null) {
        console.warn(`[poll] Skipping tx ${tx.txId} — missing required fields (txTimestamp/sender/value/chainId)`, tx)
        continue
      }
      if (!await verifyCoordinatorTxData(tx)) {
        console.warn(`[poll] Skipping tx ${tx.txId} — failed on-chain verification`)
        continue
      }
      const existingEntry = txQueueMap.get(tx.txId)
      if (existingEntry) {
        // If we previously marked it failed but the coordinator still shows it pending, retry
        if (existingEntry.status === 'failed' && !pendingTxQueue.some(t => t.txId === tx.txId)) {
          console.log(`[poll] Retrying tx ${tx.txId} — previously failed locally but coordinator reports pending`)
          existingEntry.status = 'pending'
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
        receipt: null as any, // receipt not needed — process functions use explicit params
        from: tx.sender,      // coordinator stores toEthereumAddress(destination)
        value,
        txId: tx.txId,
        type: bridgeType,
        chainId: tx.chainId,
        txTimestamp: tx.txTimestamp,
      }

      if (rejectOldTransactions) {
        const currentTimestamp = Date.now()
        if (currentTimestamp - tx.txTimestamp > TX_CLEANUP_MAX_AGE) {
          console.warn(
            `[poll] Tx ${tx.txId} is older than 24h (age: ${Math.floor((currentTimestamp - tx.txTimestamp) / 3_600_000)}h) — archiving and skipping`,
          )
          appendToTxDataStore(txData)
          appendToFailedTxsLogs(txData, 'tx older than 24h max age — skipped by poll')
          if (existingEntry) {
            existingEntry.status = 'failed'
          } else {
            txQueueMap.set(tx.txId, { txTimestamp: tx.txTimestamp, status: 'failed' })
          }
          continue
        }
      }

      pendingTxQueue.push(txData)
      if (!existingEntry) {
        txQueueMap.set(tx.txId, { txTimestamp: tx.txTimestamp, status: 'pending' })
      }
      appendToTxDataStore(txData)

      if (verboseLogs) {
        const chainName = getChainConfigById(tx.chainId)?.name || 'Unknown'
        console.log(`[poll] ${existingEntry ? 'Re-queued' : 'Added'} ${bridgeType} tx ${tx.txId} from coordinator (${chainName})`)
      }
    }

    // Re-sort the queue so newly inserted items are in txTimestamp order.
    pendingTxQueue.sort((a, b) => {
      const ta = a.txTimestamp ?? Infinity
      const tb = b.txTimestamp ?? Infinity
      return ta - tb
    })

    saveQueueToFile(ourParty.idx)
  } catch (error) {
    console.error('[poll] Error polling pending transactions from coordinator:', error)
  }
}

function isValidTransactionStatus(value: unknown): value is TransactionStatus {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TransactionStatus.PENDING &&
    value <= TransactionStatus.FAILED
  )
}

async function checkTxStatusFromCoordinator(txId: string): Promise<TransactionStatus | null> {
  try {
    const url = `${coordinatorUrl}/transaction?txId=${encodeURIComponent(txId)}`
    const response = await axios.get(url)
    const data = response.data
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid coordinator response shape: missing or non-object data')
    }
    if (!('Ok' in data) || data.Ok == null) {
      throw new Error('Invalid coordinator response shape: missing Ok')
    }
    const ok = data.Ok as { transactions?: unknown[] }
    if (!Array.isArray(ok.transactions)) {
      throw new Error('Invalid coordinator response shape: Ok.transactions is not an array')
    }
    if (ok.transactions.length > 0) {
      const first = ok.transactions[0] as { status?: unknown }
      if (!isValidTransactionStatus(first?.status)) {
        throw new Error('Invalid coordinator response shape: invalid transaction status')
      }
      return first.status as TransactionStatus
    }
    return null
  } catch (error) {
    console.error(`Error checking tx status from coordinator for ${txId}:`, error)
    throw error
  }
}

async function waitForCoordinatorFinalStatus(
  txId: string,
  timeoutMs = TX_PROCESSING_TIMEOUT_MS,
): Promise<TransactionStatus.COMPLETED | TransactionStatus.FAILED> {
  const startTime = Date.now()
  while (true) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timed out waiting for coordinator final status for ${txId}`)
    }
    try {
      const status = await checkTxStatusFromCoordinator(txId)
      if (status === TransactionStatus.COMPLETED || status === TransactionStatus.FAILED) {
        return status
      }
      if (status == null) {
        console.warn(`[wait-final] ${txId} not found on coordinator yet, waiting...`)
      } else {
        const statusLabel =
          status === TransactionStatus.PENDING ? 'PENDING' : 
          status === TransactionStatus.PROCESSING ? 'PROCESSING' : `UNKNOWN(${status})`
        console.log(`[wait-final] ${txId} still ${statusLabel} on coordinator, waiting...`)
      }
    } catch (error) {
      console.warn(`[wait-final] Coordinator status check failed for ${txId}, retrying...`, error)
    }
    await delay_ms(COORDINATOR_FINAL_STATUS_POLL_INTERVAL)
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

async function reconcileTxStatusWithCoordinator(
  txId: string,
  context: 'pre-process' | 'pre-sign',
): Promise<null | 'completed' | 'failed'> {
  try {
    const status = await checkTxStatusFromCoordinator(txId)
    if (status == null || status === TransactionStatus.PENDING || status === TransactionStatus.PROCESSING) {
      return null
    }
    const statusLabel =
      status === TransactionStatus.COMPLETED ? 'completed' : 'failed'
    console.log(`⏩ ${txId} already ${statusLabel} on coordinator (${context}), skipping`)
    return statusLabel
  } catch (error: any) {
    console.warn(`[${context}] Coordinator status check failed for ${txId}, proceeding with tx:`, error)
    return null
  }
}

async function DKG(party: KeyShare, chainId?: number): Promise<KeyShare> {
  const partyIdx = party.idx

  // If chainId is provided, use chain-specific keystore
  if (chainId) {
    try {
      const chainKeystore = getKeystoreForChain(partyIdx, chainId)
      return { idx: partyIdx, res: chainKeystore, chainId }
    } catch (e) {
      console.error(`Failed to get keystore for chain ${chainId}:`, e)
      throw e
    }
  }

  // Legacy behavior for backward compatibility
  if (party.res) return party
  if (!generateKeystore && keystoreExists(partyIdx)) {
    party.res = loadKeystore(partyIdx)
  } else {
    let delay = SIGN_POLL_DELAY_MS
    try {
      party.res = await keygen(gg18, delay)
      saveKeystore(partyIdx, party.res)
    } catch (e) {
      return {idx: partyIdx, res: null as any}
    }
  }
  return party
}

async function signEthereumTransaction(
  item: KeyShare,
  tx: any,
  digest: string,
): Promise<string | null> {
  const startMemory = process.memoryUsage()
  const delay = SIGN_POLL_DELAY_MS
  const res = JSON.parse(await sign(gg18, item.res, delay, digest))
  const signature = {
    r: '0x' + res[0],
    s: '0x' + res[1],
    v: res[2],
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
  item: KeyShare,
  tx: LiberdusTx,
  digest: string,
): Promise<SignedTx | null> {
  const startMemory = process.memoryUsage()
  const delay = SIGN_POLL_DELAY_MS
  const res = JSON.parse(await sign(gg18, item.res, delay, digest))
  const signature = {
    r: '0x' + res[0],
    s: '0x' + res[1],
    v: Number(res[2]),
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
  txHash: string,
  signedTx: string,
  targetProvider: ethers.providers.JsonRpcProvider,
): Promise<{ success: boolean; reason?: string }> {
  const providerToUse = targetProvider
  try {
    const txResponse = await providerToUse.sendTransaction(signedTx)
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
): Promise<ProcessOutcome> {
  value = ethers.BigNumber.from(value)
  console.log('Processing coin to token transaction', {
    to,
    value: value.toString(),
    targetChainId,
  })

  const chainProvider = chainProviders.get(targetChainId)
  if (!chainProvider) {
    console.error(`[ProcessCoinToToken] Chain provider not found for chainId ${targetChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `chain provider not found for chainId ${targetChainId}`)
    return 'failed'
  }

  const targetChainName = chainProvider.config.name
  console.log(`Processing transaction on ${targetChainName}`)

  await waitForBridgeCooldown(chainProvider, targetChainName)
  if (!checkMaxBridgeAmount(chainProvider, value, txId, targetChainName)) {
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed on ${targetChainName}`)
    return 'failed'
  }

  const senderNonce = await chainProvider.provider.getTransactionCount(
    chainProvider.config.tssSenderAddress,
  )
  let currentGasPrice = await chainProvider.provider.getGasPrice()

  // Apply gas price logic based on chain configuration
  const gasTiers = chainProvider.config.gasConfig.gasPriceTiers
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
  const bridgeInContractAddress = chainProvider.config.contractAddress
  const tx = {
    to: bridgeInContractAddress,
    value: 0,
    data,
    nonce: senderNonce,
    gasLimit: chainProvider.config.gasConfig.gasLimit,
    gasPrice: currentGasPrice,
    chainId: targetChainId === 31338 ? 31337 : targetChainId, // [HACK] In local development, secondary contract is deployed as 31338 for chainId, but the network is 31337
  }
  console.log(`eth tx to sign on ${targetChainName}`, tx)
  const unsignedTx = ethersUtils.serializeTransaction(tx)
  let digest = ethersUtils.keccak256(unsignedTx)

  const coordinatorStatusCoinToToken = await reconcileTxStatusWithCoordinator(txId, 'pre-sign')
  if (coordinatorStatusCoinToToken != null) return coordinatorStatusCoinToToken === 'completed' ? 'skipped_coordinator_completed' : 'skipped_coordinator_failed'

  // Use chain-specific keystore for signing
  let keyShare = await DKG(ourParty, targetChainId)
  const signedTx = await signEthereumTransaction(keyShare, tx, digest)
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
    res = await retryOperation(() => injectEthereumTx(txHash, signedTx, chainProvider.provider), {
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

  const receipt = await chainProvider.provider.getTransactionReceipt(txHash)
  if (receipt) {
    if (receipt.status === 1) {
      console.log(
        `Transaction is successful - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      )
      const block = await chainProvider.provider.getBlock(receipt.blockNumber)
      chainProvider.lastBridgeInTime = block.timestamp
      // Send tx status to coordinator
      sendTxStatusToCoordinator(txId, TransactionStatus.COMPLETED, txHash)
      return 'completed'
    } else {
      console.log(
        `Transaction failed in execution - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, `failed in execution on ${targetChainName}`)
      sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, txHash, 'failed in execution')
      return 'failed'
    }
  } else {
    console.log(
      `Transaction failed - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      res.reason,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send failed on ${targetChainName}`)
    // Send tx status to coordinator
    sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, txHash, res.reason as string)
    return 'failed'
  }
}

async function processVaultBridge(
  to: string,
  value: ethers.BigNumber,
  txId: string,
  sourceChainId: number,
  destinationChainId: number,
): Promise<ProcessOutcome> {
  value = ethers.BigNumber.from(value)
  console.log('Processing vault bridge transaction', {
    to,
    value: value.toString(),
    sourceChainId,
    destinationChainId,
  })

  const sourceChainProvider = chainProviders.get(sourceChainId)
  if (!sourceChainProvider) {
    console.error(`Source chain provider not found for chainId ${sourceChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `source chain provider not found for chainId ${sourceChainId}`)
    return 'failed'
  }

  const destChainProvider = chainProviders.get(destinationChainId)
  if (!destChainProvider) {
    console.error(`Destination chain provider not found for chainId ${destinationChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `destination chain provider not found for chainId ${destinationChainId}`)
    return 'failed'
  }

  const sourceChainName = sourceChainProvider.config.name
  const destChainName = destChainProvider.config.name
  console.log(`Processing vault bridge: ${sourceChainName} -> ${destChainName}`)

  await waitForBridgeCooldown(destChainProvider, destChainName)
  if (!checkMaxBridgeAmount(destChainProvider, value, txId, destChainName)) {
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `max bridge amount check failed on ${destChainName}`)
    return 'failed'
  }

  const senderNonce = await destChainProvider.provider.getTransactionCount(
    destChainProvider.config.tssSenderAddress,
  )
  let currentGasPrice = await destChainProvider.provider.getGasPrice()

  // Apply gas price logic based on destination chain configuration
  const gasTiers = destChainProvider.config.gasConfig.gasPriceTiers
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

  const bridgeInContractAddress = destChainProvider.config.contractAddress
  const tx = {
    to: bridgeInContractAddress,
    value: 0,
    data,
    nonce: senderNonce,
    gasLimit: destChainProvider.config.gasConfig.gasLimit,
    gasPrice: currentGasPrice,
    chainId: destChainProvider.config.chainId === 31338 ? 31337 : destChainProvider.config.chainId, // [HACK] In local development, secondary contract is deployed as 31338 for chainId, but the network is 31337
  }
  console.log(`EVM-to-EVM tx to sign on ${destChainName}`, tx)
  const unsignedTx = ethersUtils.serializeTransaction(tx)
  let digest = ethersUtils.keccak256(unsignedTx)

  const coordinatorStatusVaultBridge = await reconcileTxStatusWithCoordinator(txId, 'pre-sign')
  if (coordinatorStatusVaultBridge != null) return coordinatorStatusVaultBridge === 'completed' ? 'skipped_coordinator_completed' : 'skipped_coordinator_failed'

  // Use destination chain's keystore for signing
  let keyShare = await DKG(ourParty, destinationChainId)
  const signedTx = await signEthereumTransaction(keyShare, tx, digest)
  if (!signedTx) {
    console.log(`Failed to sign EVM-to-EVM transaction on ${destChainName}, skipping`, txId)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `failed to sign EVM-to-EVM transaction on ${destChainName}`)
    return 'failed'
  }
  // precompute tx hash from signedTx
  const txHash = ethersUtils.keccak256(signedTx as string)
  const signerBalance = await destChainProvider.provider.getBalance(destChainProvider.config.tssSenderAddress)
  console.log(`Signer ${destChainProvider.config.tssSenderAddress} balance on ${destChainName}: ${ethersUtils.formatEther(signerBalance)} ETH`)
  console.log(`Injecting EVM-to-EVM transaction on ${destChainName}`, txHash)
  let res: { success: boolean; reason?: string }
  // Retry injection with linear delay progression
  try {
    res = await retryOperation(() => injectEthereumTx(txHash, signedTx, destChainProvider.provider), {
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

  const receipt = await destChainProvider.provider.getTransactionReceipt(txHash)
  if (receipt) {
    if (receipt.status === 1) {
      console.log(
        `EVM-to-EVM transaction successful - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      )
      const block = await destChainProvider.provider.getBlock(receipt.blockNumber)
      destChainProvider.lastBridgeInTime = block.timestamp
      sendTxStatusToCoordinator(txId, TransactionStatus.COMPLETED, txHash)
      return 'completed'
    } else {
      console.log(
        `EVM-to-EVM transaction failed in execution  - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      )
      const txData = processingTransactionIds.get(txId)
      if (txData) appendToFailedTxsLogs(txData, `failed in execution on ${destChainName}`)
      sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, txHash, 'failed in execution')
      return 'failed'
    }
  } else {
    console.log(
      `EVM-to-EVM transaction failed - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      res.reason,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send failed on ${destChainName}`)
    sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, txHash, res.reason as string)
    return 'failed'
  }
}

async function processTokenToCoin(
  to: string,
  value: any,
  txId: string,
  sourceChainId: number,
): Promise<ProcessOutcome> {
  console.log('Processing token to coin transaction', {to, value, txId, sourceChainId})

  const sourceChainProvider = chainProviders.get(sourceChainId)
  if (!sourceChainProvider) {
    console.error(`[ProcessTokenToCoin] Source chain provider not found for chainId ${sourceChainId}`)
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, `source chain provider not found for chainId ${sourceChainId}`)
    return 'failed'
  }

  const sourceChainName = sourceChainProvider.config.name
  console.log(`Processing transaction from ${sourceChainName}`)

  // convert ethers.BigNumber to bigint
  const amountInBigInt = BigInt(value.hex ? value.hex : value._hex)
  console.log('Amount in bigint:', amountInBigInt)
  let signedTx: SignedTx | null = null
  const tx: LiberdusTx = {
    from: toShardusAddress(sourceChainProvider.config.tssSenderAddress),
    to: toShardusAddress(to),
    amount: amountInBigInt,
    type: 'transfer',
    networkId: chainConfigs.liberdusNetworkId,
    // memo: `${txId}:${sourceChainId}`, // Include source chain info in memo
  }
  tx.chatId = calculateChatId(tx.from, tx.to)
  const currentCycleRecord = await getLatestCycleRecord()
  let futureTimestamp = currentCycleRecord.start * 1000 + currentCycleRecord.duration * 1000
  while (futureTimestamp < Date.now() + 1000 * 30) {
    futureTimestamp += 10 * 1000
  }
  tx.timestamp = await confirmFutureTimestamp(txId, futureTimestamp)
  if (verboseLogs) {
    console.log('Current timestamp:', new Date(Date.now()))
    console.log('Future timestamp confirmed:', new Date(tx.timestamp))
    console.log('Wait time:', tx.timestamp - Date.now())
    console.log('Transaction:', tx)
  }
  const hashMessage = crypto.hashObj(tx)
  let digest = ethersUtils.hashMessage(hashMessage)

  const coordinatorStatusTokenToCoin = await reconcileTxStatusWithCoordinator(txId, 'pre-sign')
  if (coordinatorStatusTokenToCoin != null) return coordinatorStatusTokenToCoin === 'completed' ? 'skipped_coordinator_completed' : 'skipped_coordinator_failed'

  // Use chain-specific keystore for signing (source chain for Liberdus transactions)
  let keyShare = await DKG(ourParty, sourceChainId)
  signedTx = await signLiberdusTransaction(keyShare, tx, digest)
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
  if (receipt && receipt.success === true) {
    console.log(
      `Transaction is successful - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId}`,
    )
    // Send tx status to coordinator
    sendTxStatusToCoordinator(txId, TransactionStatus.COMPLETED, signedTxId)
    return 'completed'
  } else if (receipt && receipt.success === false && receipt.reason) {
    console.log(
      `Transaction is failed - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId} with reason ${receipt.reason}`,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, receipt.reason)
    // Send tx status to coordinator
    sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, signedTxId, 'failed in execution')
    return 'failed'
  } else {
    console.log(
      `Transaction is failed - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId} with reason ${res.reason}`,
    )
    const txData = processingTransactionIds.get(txId)
    if (txData) appendToFailedTxsLogs(txData, res.reason ?? `send failed from ${sourceChainName}`)
    // Send tx status to coordinator
    sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, signedTxId, res.reason as string)
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
    recentlyCompletedSize: recentlyCompletedTxs.size
  })
  
  // More aggressive memory management thresholds
  const heapUsedMB = usage.heapUsed / 1024 / 1024
  const rssMB = usage.rss / 1024 / 1024
  
  // Force garbage collection if memory usage is high (lower thresholds)
  if (heapUsedMB > 40 && global.gc) { // Reduced from 50MB to 40MB
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
  if (rssMB > 120) { // Alert if RSS exceeds 120MB
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
  if (heapUsedMB > 45 || rssMB > 110) {
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

// Track recently completed transactions to avoid duplicate processing
const recentlyCompletedTxs = new Map<string, number>() // txId -> timestamp

function isRecentlyCompleted(txId: string): boolean {
  const completedTime = recentlyCompletedTxs.get(txId)
  if (!completedTime) return false
  
  const now = Date.now()
  const maxAge = 10 * 60 * 1000 // 10 minutes
  
  if (now - completedTime > maxAge) {
    recentlyCompletedTxs.delete(txId)
    return false
  }
  
  return true
}

function markTransactionCompleted(txId: string) {
  recentlyCompletedTxs.set(txId, Date.now())
  
  // Clean up old entries periodically
  if (recentlyCompletedTxs.size > 1000) {
    const now = Date.now()
    const maxAge = 10 * 60 * 1000
    
    for (const [id, timestamp] of recentlyCompletedTxs.entries()) {
      if (now - timestamp > maxAge) {
        recentlyCompletedTxs.delete(id)
      }
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

async function confirmFutureTimestamp(operationId: string, timestamp: number): Promise<number> {
  const res = await axios.post(
    coordinatorUrl + '/future-timestamp',
    buildSignedCoordinatorRequest({ key: operationId, value: timestamp }),
  )
  if (res.status !== 200) {
    throw new Error('Failed to confirm future timestamp')
  }
  return res.data.timestamp
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
  // Show help if no valid operation flag is provided
  if (!generateKeystore && !verifyKeystores && !recoverFromBackup && !process.argv[3]) {
    console.log('\nUsage: ts-node scripts/tss-party.ts <party_index> <operation> [options]')
    console.log('\nOperations:')
    console.log('  --keygen  : Generate new keystores for all supported chains (pure key generation)')
    console.log('  --verify  : Verify and test existing keystores, display EOA addresses')
    console.log('  --recover : Recover transaction queue from emergency backup [timestamp]')
    console.log('  (none)    : Start normal TSS party operation (requires existing keystores)')
    console.log('\nExamples:')
    console.log('  ts-node scripts/tss-party.ts 1 --keygen       # Generate keystores for party 1')
    console.log('  ts-node scripts/tss-party.ts 1 --verify       # Verify keystores for party 1')
    console.log('  ts-node scripts/tss-party.ts 1 --recover      # Recover from latest emergency backup')
    console.log('  ts-node scripts/tss-party.ts 1 --recover 1234 # Recover from specific backup timestamp')
    console.log('  ts-node scripts/tss-party.ts 1                # Start party 1 for TSS operations')
    console.log('')
  }

  if (generateKeystore) {
    // Pure key generation for all supported chains
    const partyIdx = ourParty.idx
    console.log(`Generating keystores for party ${partyIdx} for all supported chains...`)

    try {
      // Ensure all chain keystores exist for this party
      const keystores = await ensureChainKeystores(partyIdx)
      console.log(`Successfully generated keystores for all ${keystores.size} chains`)
      console.log('Use --verify flag to test and verify the generated keystores')
      process.exit(0)
    } catch (e) {
      console.error('Error generating key shares:', e)
      process.exit(1)
    }
  }

  if (recoverFromBackup) {
    // Recovery mode - restore from emergency backup
    const partyIdx = ourParty.idx
    const timestamp = recoveryTimestamp ? parseInt(recoveryTimestamp) : undefined
    
    console.log(`Recovering transaction queue for party ${partyIdx}...`)
    
    const success = recoverFromEmergencyBackup(partyIdx, timestamp)
    if (success) {
      console.log('✅ Emergency recovery completed successfully')
      console.log('You can now start the TSS party normally')
    } else {
      console.log('❌ Emergency recovery failed')
      console.log('Check if emergency backup files exist in the keystores directory')
    }
    process.exit(success ? 0 : 1)
  }

  if (verifyKeystores) {
    // Verify and test keystores, display EOA addresses
    const partyIdx = ourParty.idx
    console.log(`Verifying keystores for party ${partyIdx} for all supported chains...`)

    try {
      // Load existing keystores
      const keystores = new Map<number, string>()
      
      for (const chainId of getEffectiveChainIds()) {
        try {
          const keystore = getKeystoreForChain(partyIdx, chainId)
          keystores.set(chainId, keystore)
          console.log(`Loaded keystore for chain ${chainId}`)
        } catch (e) {
          console.error(`Failed to load keystore for chain ${chainId}:`, e)
          continue
        }
      }

      if (keystores.size === 0) {
        console.error('No keystores found. Please run with --keygen first.')
        process.exit(1)
      }

      // Display public keys and addresses for each keystore
      console.log(`\n🔑 EOA Addresses Summary for Party ${partyIdx}:`)
      console.log('=' .repeat(60))
      
      for (const [chainId, keystore] of keystores.entries()) {
        const chainConfig = getChainConfigById(chainId)
        const chainName = chainConfig?.name || `Chain ${chainId}`

        console.log(`\n${chainName} (Chain ID: ${chainId}):`)
        console.log(`  🗂️  Keystore: ✅ Found`)
        
        // Check if public key file exists, if not, generate it from keystore
        const publicKeyFilePath = path.join(KEYSTORE_DIR, `public_key_party_${partyIdx}_chain_${chainId}.json`)
        
        try {
          // Always try to extract and display the public key and address from keystore
          const { publicKey, address } = extractPublicKeyFromKeystore(keystore)
          console.log(`  📍 Address: ${address}`)
          console.log(`  🔑 Public Key: ${publicKey}`)
          
          if (fs.existsSync(publicKeyFilePath)) {
            console.log(`  📄 Public Key File: ✅ Found`)
          } else {
            // Generate the public key file from keystore
            generatePublicKeyFile(partyIdx, chainId)
            console.log(`  📄 Public Key File: ✅ Generated`)
          }
        } catch (e) {
          console.log(`  📄 Public Key File: ❌ Error extracting from keystore`)
          console.log(`  ⚠️  Error: ${e instanceof Error ? e.message : String(e)}`)
        }
        
        console.log(`  🌐 RPC URL: ${chainConfig?.rpcUrl}`)
        console.log(`  📋 Contract: ${chainConfig?.contractAddress}`)
      }

      console.log(`\n✅ Verification complete for all ${keystores.size} chains`)
      console.log('📄 All public key files have been generated from keystores')
      console.log('\nNote: This verification extracts addresses from keystores without TSS coordination.')
      console.log('      For full TSS signing tests, you need to coordinate with other parties.')
      process.exit(0)
    } catch (e) {
      console.error('Error verifying keystores:', e)
      process.exit(1)
    }
  }

  // Ensure all chain keystores exist before starting normal operation
  try {
    console.log(`Ensuring all chain keystores exist for party ${ourParty.idx}...`)
    await ensureChainKeystores(ourParty.idx)
    console.log('All chain keystores are ready')
  } catch (e) {
    console.error('Failed to ensure chain keystores:', e)
    process.exit(1)
  }

  // Load persisted queue state
  loadQueueFromFile(ourParty.idx)

  // Startup recovery: verify pending/processing entries against coordinator
  console.log('🔄 Running startup recovery check against coordinator...')
  const txIdsToCheck = [...txQueueMap.entries()]
    .filter(([, entry]) => entry.status === 'pending' || entry.status === 'processing')
    .map(([txId]) => txId)

  for (const txId of txIdsToCheck) {
    try {
      const coordinatorStatus = await checkTxStatusFromCoordinator(txId)
      const entry = txQueueMap.get(txId)!

      if (coordinatorStatus === TransactionStatus.COMPLETED) {
        entry.status = 'completed'
        // Remove from pendingTxQueue if present
        const idx = pendingTxQueue.findIndex(t => t.txId === txId)
        if (idx !== -1) pendingTxQueue.splice(idx, 1)
        console.log(`[startup] ${txId} already COMPLETED on coordinator, skipping`)
      } else if (coordinatorStatus === TransactionStatus.FAILED) {
        entry.status = 'failed'
        const idx = pendingTxQueue.findIndex(t => t.txId === txId)
        const txData = idx !== -1 ? pendingTxQueue[idx] : undefined
        if (idx !== -1) pendingTxQueue.splice(idx, 1)
        if (txData) appendToFailedTxsLogs(txData, 'already failed on coordinator at startup')
        console.log(`[startup] ${txId} already FAILED on coordinator, skipping`)
      } else {
        // PENDING or PROCESSING on coordinator — ensure txData is in pendingTxQueue
        const alreadyInQueue = pendingTxQueue.some(t => t.txId === txId)
        if (!alreadyInQueue) {
          // Was processing when we crashed — look up txData in txDataStore files
          const txData = findInTxDataStoreFiles(txId)
          if (txData) {
            pendingTxQueue.push(txData)
            entry.status = 'pending'
            console.log(`[startup] Recovered in-flight tx ${txId} from txDataStore, re-queued`)
          } else {
            entry.status = 'failed'
            console.warn(`[startup] Cannot recover txData for ${txId}, marking failed`)
          }
        }
      }
    } catch (err) {
      console.warn(`[startup] Coordinator check failed for ${txId}, skipping`, err)
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

    const getRemainingProcessingTimeMs = (): number =>
      Math.max(0, TX_PROCESSING_TIMEOUT_MS - (Date.now() - startTime))
    
    // Check if this transaction was recently completed to avoid duplicate processing
    if (isRecentlyCompleted(txId)) {
      console.log(`⏩ Transaction ${txId} was recently completed, skipping duplicate processing`)
      txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
      processingTransactionIds.delete(txId)
      return
    }

    // Verify with coordinator that this tx hasn't already been completed/is being processed
    const preProcessStatus = await reconcileTxStatusWithCoordinator(txId, 'pre-process')
    if (preProcessStatus != null) {
      processingTransactionIds.delete(txId)
      if (preProcessStatus === 'completed') {
        markTransactionCompleted(txId)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
      } else if (preProcessStatus === 'failed') {
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        appendToFailedTxsLogs(validTx, 'already failed on coordinator at pre-process')
      }
      await refreshLastBridgeInTime(txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
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
        )
      } else if (validTx.type === 'tokenToCoin') {
        console.log('Processing token to coin transaction', validTx)
        processPromise = processTokenToCoin(
          validTx.from,
          validTx.value as ethers.BigNumber,
          validTx.txId,
          validTx.chainId,
        )
      } else if (validTx.type === 'vaultBridge') {
        console.log('Processing vault bridge (EVM-to-EVM) transaction', validTx)
        processPromise = processVaultBridge(
          validTx.from,
          validTx.value as ethers.BigNumber,
          validTx.txId,
          validTx.chainId,
          chainConfigs.secondaryChainConfig!.chainId,
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
        
        // Mark transaction as completed to prevent duplicate processing
        markTransactionCompleted(validTx.txId)
      } else if (outcome === 'failed') {
        txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        console.warn(`Transaction ${validTx.txId} reported failed outcome during processing`)
      } else if (outcome === 'skipped_coordinator_completed') {
        console.log(`Transaction ${validTx.txId} was already completed on coordinator (pre-sign), skipping`)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
        markTransactionCompleted(validTx.txId)
        await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
      } else if (outcome === 'skipped_coordinator_failed') {
        console.log(`Transaction ${validTx.txId} was already failed on coordinator (pre-sign), skipping`)
        txQueueMap.set(txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
        appendToFailedTxsLogs(validTx, 'already failed on coordinator before signing')
        await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
      }
      
      // Check memory usage after successful transaction
      checkPostTransactionMemory(validTx.txId, 'transaction-success')
      
      // Force cleanup after successful transaction processing
      if (global.gc) {
        global.gc()
      }
    } catch (error: any) {
      if (error.message === enoughPartyError) {
        // Handle the "enough party" error - this means other parties already completed the signing
        // Keep this tx in local "processing" until coordinator finalizes it.
        console.log('Transaction already signed by enough parties, waiting for coordinator final status:', validTx.txId)

        let finalStatus: TransactionStatus.COMPLETED | TransactionStatus.FAILED
        try {
          const remainingTimeoutMs = getRemainingProcessingTimeMs()
          finalStatus = await waitForCoordinatorFinalStatus(validTx.txId, remainingTimeoutMs)
        } catch (waitError) {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
          appendToFailedTxsLogs(validTx, 'timeout waiting for coordinator final status after enough-party')
          saveQueueToFile(ourParty.idx)
          console.warn(`[wait-final] Timed out waiting for final status for ${validTx.txId}`)
          throw waitError
        }

        if (finalStatus === TransactionStatus.COMPLETED) {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'completed' })
          markTransactionCompleted(validTx.txId)
          await refreshLastBridgeInTime(validTx.txId, validTx.type as TransactionQueueItem['type'], validTx.chainId)
          console.log(`[wait-final] ${validTx.txId} finalized as COMPLETED on coordinator`)
        } else {
          txQueueMap.set(validTx.txId, { txTimestamp: validTx.txTimestamp!, status: 'failed' })
          appendToFailedTxsLogs(validTx, 'finalized as failed on coordinator after enough-party')
          console.warn(`[wait-final] ${validTx.txId} finalized as FAILED on coordinator`)
        }

        saveQueueToFile(ourParty.idx)

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
    while (pendingTxQueue.length > 0 && processingTransactionIds.size < MAX_CONCURRENT_TXS) {
      const validTx = pendingTxQueue.shift()!

      // Update transaction status to processing
      txQueueMap.set(validTx.txId, {
        txTimestamp: validTx.txTimestamp!,
        status: 'processing',
      })
      saveQueueToFile(ourParty.idx)

      // Store full txData in processingTransactionIds for crash recovery
      processingTransactionIds.set(validTx.txId, validTx)

      // // Report PROCESSING to coordinator for DB accuracy and crash recovery visibility.
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

  function startDriftResistantScheduler(fn: () => void | Promise<void>, intervalMS: number) {
    console.log(`Starting drift-resistant scheduler for ${fn.name} with interval ${intervalMS} ms`)
    const intervalSeconds = Math.round(intervalMS / 1000)

    function scheduleNext() {
      const now = new Date()
      const currentSeconds = now.getSeconds()

      // Find next exact boundary (e.g., if every 3s: 0, 3, 6, ..., 57)
      let nextBoundary = Math.floor(currentSeconds / intervalSeconds + 1) * intervalSeconds

      let targetTime = new Date(now)

      if (nextBoundary >= 60) {
        // Go to next minute if needed
        targetTime.setMinutes(targetTime.getMinutes() + 1)
        targetTime.setSeconds(nextBoundary - 60, 0)
      } else {
        targetTime.setSeconds(nextBoundary, 0)
      }

      const delay = targetTime.getTime() - now.getTime()

      // console.log(`Next run at: ${targetTime.toISOString()}, waiting ${delay}ms`);

      setTimeout(() => {
        fn()
        scheduleNext()
      }, delay)
    }

    // Start the first execution
    scheduleNext()
  }

  startDriftResistantScheduler(handleTransactionQueue, txQueueProcessingInterval)
  // Add memory management and monitoring schedulers
  startDriftResistantScheduler(cleanupOldTransactions, 10 * 60 * 1000) // Every 10 minutes
  startDriftResistantScheduler(logMemoryUsage, 5 * 60 * 1000) // Every 5 minutes
  startDriftResistantScheduler(cleanupStuckTransactions, 2 * 60 * 1000) // Every 2 minutes

  // Coordinator-monitored mode: poll coordinator for pending transactions
  startDriftResistantScheduler(pollPendingTransactionsFromCoordinator, COORDINATOR_POLL_INTERVAL)
}

main()
  .then(() => {
  })
  .catch((error) => {
    console.error('Fatal error in main:', error)
    process.exit(1)
  })
