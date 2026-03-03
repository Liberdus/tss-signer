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
  wsUrl: string
  contractAddress: string
  tssSenderAddress: string
  bridgeAddress: string
  gasConfig: {
    gasLimit: number
    gasPriceTiers: number[]
  }
  deploymentBlock?: number // Block number when the contract was deployed (used as starting point for historical scan)
}

interface ChainConfigs {
  supportedChains: Record<string, ChainConfig>
  vaultChain?: ChainConfig      // Vault source chain config (used when enableLiberdusNetwork=false)
  secondaryChainConfig?: ChainConfig // Vault destination chain config (used when enableLiberdusNetwork=false)
  enableLiberdusNetwork: boolean
  liberdusNetworkId: string
  coordinatorUrl?: string // Coordinator server URL (default: http://127.0.0.1:8000)
  collectorHost?: string // Collector server URL (default: http://127.0.0.1:3035)
  proxyServerHost?: string // Proxy server URL (default: http://127.0.0.1:3030)
}

interface ChainProviders {
  provider: ethers.providers.JsonRpcProvider
  wsProvider: ethers.providers.WebSocketProvider
  config: ChainConfig
  lastCheckedBlockNumber: number
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

interface TxQueueMapValue {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  from: string
  value: ethers.BigNumber | bigint
  txId: string
  chainId?: number // Add chainId to track which chain this transaction belongs to
  timestamp?: number // Add timestamp for cleanup purposes
  [key: string]: any
}

interface KeyShare {
  idx: number
  res: string
  chainId?: number // Add chainId to identify which chain this keystore is for
}


interface BridgeOutEvent {
  from: string
  amount: ethers.BigNumber
  targetAddress: string
  chainId: number
  txId: string
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

// Transaction data sent to the coordinator
interface TxData extends Omit<Transaction, 'createdAt' | 'updatedAt' | 'reason'> {
  party: number;
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
const loadExistingQueue = true
const verboseLogs = true
const addOldTxToQueue = true
const useQueryFilter = true // Use queryFilter for efficient event scanning (vs block-by-block getBlockWithTransactions)
const enableLocalMonitoring = false // When false, coordinator handles EVM/Liberdus monitoring; TSS party polls coordinator instead

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

let t = params.threshold
let n = params.parties

// Unified BridgedOut event ABI (all contracts use this 5-param signature)
const BRIDGE_OUT_EVENT_ABI = 'event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)'

// Shared bridge contract ABI for state reads and bridgeIn
const BRIDGE_CONTRACT_ABI = [
  'function bridgeInCooldown() view returns (uint256)',
  'function maxBridgeInAmount() view returns (uint256)',
  'function lastBridgeInTime() view returns (uint256)',
  'function bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId) public',
]
const BRIDGE_CONTRACT_IFACE = new ethersUtils.Interface(BRIDGE_CONTRACT_ABI)

/** Returns chain IDs active in the current mode (vault mode or Liberdus mode) */
function getEffectiveChainIds(): number[] {
  if (chainConfigs.enableLiberdusNetwork) {
    return Object.keys(chainConfigs.supportedChains).map(Number)
  }
  return [chainConfigs.vaultChain!.chainId, chainConfigs.secondaryChainConfig!.chainId]
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

const rpcConfigByChainId: Record<string, {rpcUrl: string; wsUrl: string}> = {}
for (const config of chainsToInit) {
  rpcConfigByChainId[config.chainId.toString()] = {
    rpcUrl: config.rpcUrl,
    wsUrl: config.wsUrl,
  }
}
rpcUrls.initFromConfig(rpcConfigByChainId, '')
rpcUrls.startHourlyChainlistFetch(chainsToInit.map((c) => c.chainId), '')

// Initialize providers for all supported chains
const chainProviders: Map<number, ChainProviders> = new Map()

for (const config of chainsToInit) {
  const chainId = config.chainId
  const fallbackRpcUrl = config.rpcUrl

  const provider = getHttpProviderForChain(rpcUrls.getHttpUrls(chainId), {
    fallbackRpcUrl,
    chainId,
  })

  // Only create WebSocket provider if not in keygen mode, URL is valid, and local monitoring is enabled
  let wsProvider: ethers.providers.WebSocketProvider | null = null
  if (!generateKeystore && enableLocalMonitoring) {
    try {
      const wsUrl = config.wsUrl
      wsProvider = new ethers.providers.WebSocketProvider(wsUrl)
      console.log(`WebSocket provider initialized for ${config.name} (Chain ID: ${chainId})`)
    } catch (error) {
      console.warn(`Failed to initialize WebSocket provider for ${config.name}: ${error}`)
      console.log(`Will use HTTP provider only for ${config.name}`)
    }
  }

  chainProviders.set(chainId, {
    provider,
    wsProvider: wsProvider!,
    config,
    lastCheckedBlockNumber: 0,
    bridgeInCooldown: 0,
    maxBridgeInAmount: ethers.BigNumber.from(0),
    lastBridgeInTime: 0,
  })

  console.log(`HTTP provider initialized for ${config.name} (Chain ID: ${chainId})`)
}

// Fetch bridge contract state (cooldown, maxAmount, lastBridgeInTime) for a chain
async function fetchBridgeState(chainId: number): Promise<void> {
  const chainProvider = chainProviders.get(chainId)
  if (!chainProvider) return

  const contractAddr = chainProvider.config.contractAddress
  try {
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

let lastCheckedTimestamp = serverStartTime

const cryptoInitKey = '69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc'
crypto.init(cryptoInitKey)
crypto.setCustomStringifier(stringify, 'shardus_safeStringify')

const KEYSTORE_DIR = path.join(__dirname, '../keystores')

// enough party subscribed error
const enoughPartyError = 'Enough party already registerd to sign this transaction'

if (!fs.existsSync(KEYSTORE_DIR)) {
  fs.mkdirSync(KEYSTORE_DIR, {recursive: true})
}

const txQueue: TransactionQueueItem[] = []
const txQueueMap: Map<string, TxQueueMapValue> = new Map()
const txQueueSize = 10
const txQueueProcessingInterval = 10000
const liberdusTxMonitorInterval = 10000
const ethereumTxMonitorInterval = 10000
const COORDINATOR_POLL_INTERVAL = 10 * 1000 // 10s

// Define maximum concurrent transactions
const MAX_CONCURRENT_TXS = 1
const processingTransactionIds = new Set<string>()

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
  const maxAge = 2 * 60 * 60 * 1000 // Reduced to 2 hours for more aggressive cleanup
  const maxPendingAge = 30 * 60 * 1000 // 30 minutes for pending transactions
  let removedCount = 0
  let statusCounts = { pending: 0, processing: 0, completed: 0, failed: 0, unknown: 0 }
  
  for (const [txId, txData] of txQueueMap.entries()) {
    // Count transaction statuses for debugging
    statusCounts[txData.status as keyof typeof statusCounts] = (statusCounts[txData.status as keyof typeof statusCounts] || 0) + 1
    
    const txTimestamp = txData.timestamp || 0
    const txAge = now - txTimestamp
    
    let shouldRemove = false
    
    if (txData.status === 'completed' || txData.status === 'failed') {
      // Remove completed/failed transactions older than 2 hours
      shouldRemove = txAge > maxAge
    } else if (txData.status === 'pending' && txTimestamp > 0) {
      // Remove pending transactions older than 30 minutes (likely stuck)
      shouldRemove = txAge > maxPendingAge
    } else if (txTimestamp === 0) {
      // Remove transactions without timestamps that are older than server start
      shouldRemove = now - serverStartTime > maxAge
    }
    
    if (shouldRemove) {
      txQueueMap.delete(txId)
      processingTransactionIds.delete(txId)
      removedCount++
      
      if (verboseLogs) {
        console.log(`🗑️ Removed ${txData.status} transaction ${txId} (age: ${Math.round(txAge / 60000)}min)`)
      }
    }
  }
  
  // Always log cleanup results for monitoring
  console.log(`🧹 Cleanup complete. Removed ${removedCount} transactions. Status counts:`, statusCounts)
  console.log(`📊 Current txQueueMap size: ${txQueueMap.size}, processingSet size: ${processingTransactionIds.size}`)
  
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
      const delay = Math.max(Math.random() * 500, 100)
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
    queue: txQueue,
    map: Array.from(txQueueMap.entries()),
  }
  fs.writeFileSync(filePath, JSON.stringify(data))
  console.log(`Queue for party ${party} saved to ${filePath}`)
}

const loadQueueFromFile = (partyIdx: number): void => {
  const party = partyIdx === undefined ? 'all' : String(partyIdx)
  const filePath = path.join(KEYSTORE_DIR, `queue_party_${party}.json`)
  if (fs.existsSync(filePath)) {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    txQueue.push(...data.queue)
    data.map.forEach(([key, value]: [string, TxQueueMapValue]) => {
      txQueueMap.set(key, value)
    })
    console.log(`Queue for party ${party} loaded from ${filePath}`)
  }
}

interface BlockStateFile {
  [chainId: string]: number | undefined
}

const saveBlockState = async (partyIdx: number): Promise<void> => {
  const party = partyIdx === undefined ? 'all' : String(partyIdx)
  const filePath = path.join(KEYSTORE_DIR, `block_state_party_${party}.json`)
  const state: BlockStateFile = {}
  for (const [chainId, cp] of chainProviders.entries()) {
    state[chainId.toString()] = cp.lastCheckedBlockNumber
  }
  await writeFile(filePath, JSON.stringify(state), 'utf8')
}

const loadBlockState = (partyIdx: number): BlockStateFile | null => {
  const party = partyIdx === undefined ? 'all' : String(partyIdx)
  const filePath = path.join(KEYSTORE_DIR, `block_state_party_${party}.json`)
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
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
    txQueue.length = 0
    txQueueMap.clear()
    processingTransactionIds.clear()
    
    txQueue.push(...backupData.queue)
    backupData.map.forEach(([key, value]: [string, TxQueueMapValue]) => {
      txQueueMap.set(key, value)
    })
    
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

async function validateTokenToCoinTx(
  tx: ethers.providers.TransactionResponse,
  targetChainId: number,
): Promise<BridgeOutEvent | false> {
  const chainProvider = chainProviders.get(targetChainId)
  if (!chainProvider) {
    console.log(`[validateTokenToCoinTx] Chain provider not found for chainId ${targetChainId}`)
    return false
  }

  const receipt = await chainProvider.provider.getTransactionReceipt(tx.hash)
  console.log('receipt', receipt)
  console.log(`Starting block: ${chainProvider.lastCheckedBlockNumber}`)
  console.log(`Transaction block number: ${receipt.blockNumber}`)

  if (!addOldTxToQueue) {
    if (receipt.blockNumber < chainProvider.lastCheckedBlockNumber) {
      console.log('Transaction is older than the server start block')
      return false
    }
  }
  if (receipt.status !== 1) {
    console.log('Transaction is not successful')
    return false
  }
  const expectedContract = chainProvider.config.contractAddress.toLowerCase()
  if (receipt.to?.toLowerCase() !== expectedContract) {
    console.log(`Transaction is not for the ${chainProvider.config.name} bridge contract address`)
    return false
  }

  const bridgeInterface = new ethersUtils.Interface([BRIDGE_OUT_EVENT_ABI])

  const bridgeOutLog = receipt.logs.find((log: any) => {
    try {
      if (log.address.toLowerCase() !== expectedContract)
        return false
      const parsedLog = bridgeInterface.parseLog(log)
      return parsedLog.name === 'BridgedOut'
    } catch (e) {
      return false
    }
  })

  if (!bridgeOutLog) {
    console.log('No BridgedOut event found in transaction logs')
    return false
  }
  const parsedLog = bridgeInterface.parseLog(bridgeOutLog)
  const from = parsedLog.args.from
  const amount = parsedLog.args.amount
  const targetAddress = parsedLog.args.targetAddress
  const parsedChainId = parsedLog.args.chainId.toNumber()

  console.log('BridgedOut event data:', { from, amount: amount.toString(), targetAddress, chainId: parsedChainId })

  if (parsedChainId === targetChainId) {
    console.log('Transaction is trying to bridge to the same chain')
    return false
  }

  return {
    from,
    targetAddress,
    amount,
    chainId: parsedChainId,
    txId: receipt.transactionHash,
  }
}

function validateCoinToTokenTx(
  receipt: any,
): { from: string; value: ethers.BigNumber; txId: string; targetChainId: number } | false {
  console.log('receipt', receipt)
  const {success, to, from, additionalInfo, type, txId, timestamp} = receipt.data

  if (!addOldTxToQueue) {
    if (timestamp < serverStartTime) {
      console.log('Transaction is older than the server start time')
      return false
    }
  }
  if (!success) {
    console.log('Transaction is not successful')
    return false
  }

  // Find which chain this transaction is targeting based on the bridge address
  let targetChainId: number | null = null
  for (const [chainIdStr, config] of Object.entries(chainConfigs.supportedChains)) {
    if (to === config.bridgeAddress) {
      targetChainId = parseInt(chainIdStr)
      break
    }
  }

  if (targetChainId === null) {
    console.log('Transaction is not for any known bridge address')
    return false
  }

  if (type !== 'transfer') {
    console.log('Transaction type is not transfer')
    return false
  }
  const transferAmountInBigInt = BigNumber.from('0x' + additionalInfo.amount.value)
  return {from, value: transferAmountInBigInt, txId, targetChainId}
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
  
  let context = null
  try {
    context = await m.gg18_sign_client_new_context(
      coordinatorUrl,
      t,
      n,
      key_store,
      digest.slice(2),
      operationId,
    )
    let contextJSON = JSON.parse(context)
    if (contextJSON.party_num_int > t + 1) {
      console.log('Party number is greater than threshold + 1, returning')
      throw new Error(enoughPartyError)
    }
    console.log('our party number', contextJSON.party_num_int)

    console.log('sign round', 0)
    context = await m.gg18_sign_client_round0(context, delay)
    console.log('sign round', 1)
    context = await m.gg18_sign_client_round1(context, delay)
    console.log('sign round', 2)
    context = await m.gg18_sign_client_round2(context, delay)
    console.log('sign round', 3)
    context = await m.gg18_sign_client_round3(context, delay)
    console.log('sign round', 4)
    context = await m.gg18_sign_client_round4(context, delay)
    console.log('sign round', 5)
    context = await m.gg18_sign_client_round5(context, delay)
    console.log('sign round', 6)
    context = await m.gg18_sign_client_round6(context, delay)
    console.log('sign round', 7)
    context = await m.gg18_sign_client_round7(context, delay)
    console.log('sign round', 8)
    context = await m.gg18_sign_client_round8(context, delay)
    const sign_json = await m.gg18_sign_client_round9(context, delay)
    console.log('Signature:', sign_json)
    
    // Force cleanup after successful signing
    if (global.gc) {
      global.gc()
    }
    
    return sign_json
  } catch (error) {
    // Clean up any context or resources on error
    console.log('Error in sign function, cleaning up resources')
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

async function monitorEthereumTransactions(): Promise<void> {
  if (!enableLocalMonitoring) return
  // Monitor all supported EVM chains
  for (const [chainId, chainProvider] of chainProviders.entries()) {
    try {
      console.log(
        `Monitoring Ethereum transactions for bridgeOut calls on ${chainProvider.config.name}...`,
      )
      const newestBlockNumber = await chainProvider.provider.getBlockNumber()
      if (verboseLogs) console.log(`Newest block number for ${chainProvider.config.name}:`, newestBlockNumber)

      if (chainProvider.lastCheckedBlockNumber >= newestBlockNumber) {
        console.log(
          `This block has already been checked for ${chainProvider.config.name}, skipping...`,
          chainProvider.lastCheckedBlockNumber,
          newestBlockNumber,
        )
        continue
      }

      // Start from lastCheckedBlockNumber - 10 for redundancy (duplicates skipped via txQueueMap)
      const deploymentBlock = chainProvider.config.deploymentBlock ?? 0
      const scanStart = Math.max(deploymentBlock, chainProvider.lastCheckedBlockNumber - 10)
      for (let i = scanStart; i <= newestBlockNumber; i++) {
        const block = await chainProvider.provider.getBlockWithTransactions(i)
        if (verboseLogs) console.log(`Processing block ${i} on ${chainProvider.config.name}`, block.number)
        if (verboseLogs) console.log('Found block with transactions:', block.transactions.length)

        const transactions = block.transactions.filter(
          (tx: any) =>
            tx.to && tx.to.toLowerCase() === chainProvider.config.contractAddress.toLowerCase(),
        )
        console.log(
          `Filtered transactions for ${chainProvider.config.name} contract:`,
          transactions.length,
        )

        let validTransactions: BridgeOutEvent[] = []
        if (transactions.length > 0) {
          for (const tx of transactions) {
            if (!tx.data.startsWith('0xeca34900')) continue
            const validateResult = await validateTokenToCoinTx(tx, chainId)
            if (!validateResult) continue
            validTransactions.push(validateResult)
          }
        }

        if (txQueue.length + validTransactions.length > txQueueSize) {
          throw new Error('Not enough space in the transaction queue')
        }

        for (const validTx of validTransactions) {
          if (txQueueMap.has(validTx.txId)) continue

          // In vault mode, events on vaultChain → vaultBridge; in Liberdus mode → tokenToCoin
          const bridgeType: TransactionQueueItem['type'] =
            !chainConfigs.enableLiberdusNetwork ? 'vaultBridge' : 'tokenToCoin'

          const txData: TransactionQueueItem = {
            receipt: validTx,
            from: validTx.targetAddress,
            value: validTx.amount,
            txId: validTx.txId,
            type: bridgeType,
            chainId: chainId,
          }
          txQueue.push(txData)
          txQueueMap.set(validTx.txId, {
            status: 'pending',
            from: validTx.from,
            value: validTx.amount,
            txId: validTx.txId,
            chainId: chainId,
            timestamp: Date.now(), // Add timestamp for cleanup
          })
          saveQueueToFile(ourParty.idx)
          if (verboseLogs) {
            console.log(
              `Ethereum transaction added to queue from ${chainProvider.config.name}:`,
              validTx,
            )
          }
          sendTxDataToCoordinator(txData, block.timestamp * 1000)
        }
        chainProvider.lastCheckedBlockNumber = i
        await saveBlockState(ourParty.idx)
      }
    } catch (error) {
      console.error(
        `Error monitoring Ethereum transactions on ${chainProvider.config.name}:`,
        error,
      )
    }
  }
}

// Concurrency guard — prevents overlapping invocations from the scheduler
let isQueryFilterRunning = false

// Persistent adaptive batch size per chain (survives across scheduler invocations)
const chainBatchSizes: Map<number, number> = new Map()
const INITIAL_BATCH_SIZE = 1000
const MIN_BATCH_SIZE = 100
const BASE_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 30000
const MAX_RETRIES_PER_BATCH = 5

async function monitorEthereumTransactionsQueryFilter(): Promise<void> {
  if (!enableLocalMonitoring) return
  if (isQueryFilterRunning) {
    if (verboseLogs) console.log('[queryFilter] Previous invocation still running, skipping this interval')
    return
  }
  isQueryFilterRunning = true

  try {
    for (const [chainId, chainProvider] of chainProviders.entries()) {
      // In vault mode, only vaultChain emits events — skip secondaryChainConfig
      if (!chainConfigs.enableLiberdusNetwork && chainId === chainConfigs.secondaryChainConfig!.chainId) continue

      try {
        const chainName = chainProvider.config.name
        const newestBlockNumber = await chainProvider.provider.getBlockNumber()

        if (chainProvider.lastCheckedBlockNumber >= newestBlockNumber) {
          if (verboseLogs) console.log(`Already up to date for ${chainName}, skipping...`)
          continue
        }

        // Start from lastCheckedBlockNumber - 10 for redundancy (duplicates skipped via txQueueMap)
        const deploymentBlock = chainProvider.config.deploymentBlock ?? 0
        const fromBlock = Math.max(deploymentBlock, chainProvider.lastCheckedBlockNumber - 10)
        const toBlock = newestBlockNumber
        console.log(`[queryFilter] Scanning ${chainName} from block ${fromBlock} to ${toBlock} (${toBlock - fromBlock + 1} blocks)`)

        const contractAddress = chainProvider.config.contractAddress

        console.log(`[queryFilter] Contract address: ${contractAddress}`)

        const bridgeInterface = new ethersUtils.Interface([BRIDGE_OUT_EVENT_ABI])

        const contract = new ethers.Contract(
          contractAddress,
          bridgeInterface,
          chainProvider.provider,
        )

        // Use persistent batch size for this chain (remembers across invocations)
        let batchSize = chainBatchSizes.get(chainId) ?? INITIAL_BATCH_SIZE
        let cursor = fromBlock
        let retryCount = 0
        let retryDelay = BASE_DELAY_MS

        while (cursor <= toBlock) {
          const batchEnd = Math.min(cursor + batchSize - 1, toBlock)
          if (verboseLogs) console.log(`[queryFilter] Batch: ${chainName} blocks ${cursor}-${batchEnd} (size: ${batchSize})`)

          let events: ethers.Event[]
          try {
            events = await contract.queryFilter(
              contract.filters.BridgedOut(),
              cursor,
              batchEnd,
            )
            console.log(`[queryFilter] Found ${events.length} events in batch`)
            // Reset retry state on success
            retryCount = 0
            retryDelay = BASE_DELAY_MS
          } catch (error: any) {
            // Check for RPC limit exceeded error (-32005) and handle with backoff
            if (error?.error?.code === -32005 || error?.code === -32005 || error?.message?.includes('limit exceeded')) {
              // First try reducing batch size
              if (batchSize > MIN_BATCH_SIZE) {
                batchSize = Math.max(Math.floor(batchSize / 2), MIN_BATCH_SIZE)
                chainBatchSizes.set(chainId, batchSize) // Persist reduced batch size
                console.warn(`[queryFilter] RPC limit exceeded for ${chainName}, reducing batch size to ${batchSize}`)
                await delay_ms(retryDelay)
                continue // Retry same cursor with smaller batch
              }
              // At min batch size — use exponential backoff instead of skipping
              retryCount++
              if (retryCount <= MAX_RETRIES_PER_BATCH) {
                retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS)
                console.warn(`[queryFilter] Rate limited on ${chainName} at min batch size, retry ${retryCount}/${MAX_RETRIES_PER_BATCH} after ${retryDelay}ms delay`)
                await delay_ms(retryDelay)
                continue // Retry same cursor after delay
              }
              // Exhausted retries — stop processing this chain for now and let the next scheduler interval resume
              console.error(`[queryFilter] Rate limit retries exhausted for ${chainName} at block ${cursor}, will resume next interval`)
              break
            }
            throw error // Re-throw non-limit errors
          }

          if (events.length > 0) {
            console.log(`[queryFilter] Found ${events.length} BridgedOut events on ${chainName} in blocks ${cursor}-${batchEnd}`)
          }

          for (const event of events) {
            if (!event.args) continue

            const eventFrom = event.args.from as string
            const amount = event.args.amount as ethers.BigNumber
            const targetAddress = event.args.targetAddress as string
            const parsedChainId = (event.args.chainId as ethers.BigNumber).toNumber()
            const eventTimestamp = event.args.timestamp as ethers.BigNumber

            // Only process events from the current chain (replay protection)
            if (parsedChainId !== chainId) continue

            // Dedup check
            if (txQueueMap.has(event.transactionHash)) continue

            const validTx: BridgeOutEvent = {
              from: eventFrom,
              amount,
              targetAddress,
              chainId: parsedChainId,
              txId: event.transactionHash,
            }

            // In vault mode, events on vaultChain → vaultBridge; in Liberdus mode → tokenToCoin
            const bridgeType: TransactionQueueItem['type'] =
              !chainConfigs.enableLiberdusNetwork ? 'vaultBridge' : 'tokenToCoin'

            if (txQueue.length >= txQueueSize) {
              console.warn(`Transaction queue full, stopping scan for ${chainName} at block ${event.blockNumber}`)
              break
            }

            const txData: TransactionQueueItem = {
              receipt: validTx,
              from: validTx.targetAddress,
              value: validTx.amount,
              txId: validTx.txId,
              type: bridgeType,
              chainId: chainId,
            }
            txQueue.push(txData)
            txQueueMap.set(validTx.txId, {
              status: 'pending',
              from: validTx.from,
              value: validTx.amount,
              txId: validTx.txId,
              chainId: chainId,
              timestamp: Date.now(),
            })
            saveQueueToFile(ourParty.idx)
            if (verboseLogs) {
              console.log(`[queryFilter] BridgedOut event added to queue from ${chainName}:`, validTx.txId)
            }
            sendTxDataToCoordinator(txData, eventTimestamp.toNumber() * 1000)
          }

          // Batch succeeded — advance cursor and try growing batch size back
          cursor = batchEnd + 1
          chainProvider.lastCheckedBlockNumber = batchEnd
          await saveBlockState(ourParty.idx)

          // Gradually increase batch size back up after success (up to initial)
          if (batchSize < INITIAL_BATCH_SIZE) {
            batchSize = Math.min(batchSize * 2, INITIAL_BATCH_SIZE)
            chainBatchSizes.set(chainId, batchSize)
          }

          // Add delay between batches to avoid triggering rate limits
          if (cursor <= toBlock) {
            await delay_ms(BASE_DELAY_MS)
          }
        }
      } catch (error) {
        console.error(`Error in queryFilter monitoring for ${chainProvider.config.name}:`, error)
      }
    }
  } finally {
    isQueryFilterRunning = false
  }
}

async function monitorLiberdusTransactions(): Promise<void> {
  if (!enableLocalMonitoring) return
  console.log('Running monitorLiberdusTransactions', new Date().toISOString())
  try {
    // Query for transactions to all bridge addresses
    const bridgeAddresses = Object.values(chainConfigs.supportedChains).map(
      (config) => config.bridgeAddress,
    )

    for (const bridgeAddress of bridgeAddresses) {
      // console.log('Updated lastCheckedTimestamp:', new Date(lastCheckedTimestamp).toISOString())
      const query = `?accountId=${bridgeAddress}&afterTimestamp=${lastCheckedTimestamp}&page=1`
      const url = collectorHost + '/api/transaction' + query
      const response = await axios.get(url)
      const {success, totalTransactions, transactions} = response.data

      if (success && totalTransactions > 0) {
        if (transactions.length > 0) {
          transactions.forEach((receipt: any, index: number) => {
            const validateResult = validateCoinToTokenTx(receipt)
            console.log('validateResult', validateResult)
            if (!validateResult) {
              console.log('Transaction validation failed, skipping:', receipt.txId)
              // Set lastCheckedTimestamp to the timestamp of the last transaction
              if (index === transactions.length - 1) {
                lastCheckedTimestamp = receipt.timestamp
              }
              return
            }
            if (txQueue.length > txQueueSize) {
              console.error('Transaction queue is full, cannot add more transactions')
              return
            }
            if (txQueueMap.has(validateResult.txId)) {
              console.log('Transaction already exists in the queue, skipping:', validateResult.txId)
              return
            }
            if (txQueue.length > txQueueSize) {
              console.error('Transaction queue is full, cannot add more transactions')
              return
            }
            if (txQueueMap.has(validateResult.txId)) {
              console.log('Transaction already exists in the queue, skipping:', validateResult.txId)
              return
            }

            const txData: TransactionQueueItem = {
              receipt,
              from: validateResult.from,
              value: validateResult.value,
              txId: validateResult.txId,
              type: 'coinToToken',
              chainId: validateResult.targetChainId,
            }
            txQueue.push(txData)
            txQueueMap.set(validateResult.txId, {
              status: 'pending',
              from: validateResult.from,
              value: validateResult.value,
              txId: validateResult.txId,
              chainId: validateResult.targetChainId,
              timestamp: Date.now(), // Add timestamp for cleanup
            })
            saveQueueToFile(ourParty.idx)
            if (verboseLogs) {
              const targetChainName = getChainConfigById(validateResult.targetChainId)?.name || 'Unknown'
              console.log(
                `Liberdus transaction added to queue (target: ${targetChainName}):`,
                validateResult,
              )
            }
            sendTxDataToCoordinator(txData, receipt.timestamp)
            // Set lastCheckedTimestamp to the timestamp of the last transaction
            if (index === transactions.length - 1) {
              lastCheckedTimestamp = receipt.timestamp
            }
          })
        }
      }
    }
  } catch (e) {
    console.error('Error monitoring Liberdus transactions:', e)
  }
}

async function sendTxDataToCoordinator(
  txData: TransactionQueueItem,
  timestamp: number,
): Promise<void> {
  const tx: TxData = {
    txId: txData.txId,
    sender: toEthereumAddress(txData.from),
    value: ethersUtils.hexValue(txData.value),
    type: txData.type === 'coinToToken'
      ? TransactionType.BRIDGE_IN
      : txData.type === 'vaultBridge'
        ? TransactionType.BRIDGE_VAULT
        : TransactionType.BRIDGE_OUT,
    txTimestamp: timestamp,
    status: TransactionStatus.PENDING,
    receiptId: '',
    party: ourParty.idx,
    chainId: txData.chainId,
  }
  try {
    const url = `${coordinatorUrl}/transaction`
    const response = await axios.post(url, tx)
    console.log('response', response.status)
    if (response.status !== 202 && response.status !== 200) {
      console.error('Failed to send txData to coordinator:', response.data)
      return
    }
    if (verboseLogs) {
      const chainName = getChainConfigById(txData.chainId)?.name || 'Unknown'
      console.log(`Sent txData to coordinator (${chainName}):`, response.data)
    }
  } catch (error) {
    console.error('Error sending txData to coordinator:', error)
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
    const response = await axios.post(url, data)
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
      if (txQueueMap.has(tx.txId)) continue
      if (txQueue.length >= txQueueSize) {
        console.warn('[poll] Transaction queue full, skipping remaining coordinator results')
        break
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

      txQueue.push(txData)
      txQueueMap.set(tx.txId, {
        status: 'pending',
        from: tx.sender,
        value,
        txId: tx.txId,
        chainId: tx.chainId,
        timestamp: Date.now(),
      })

      if (verboseLogs) {
        const chainName = getChainConfigById(tx.chainId)?.name || 'Unknown'
        console.log(`[poll] Added ${bridgeType} tx ${tx.txId} from coordinator (${chainName})`)
      }
    }

    // Re-sort the queue so newly inserted items are in txTimestamp order.
    // Items without a txTimestamp (from local monitoring) are placed last.
    txQueue.sort((a, b) => {
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
    let delay = Math.max(Math.random() * 500, 100)
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
  let delay = Math.max(Math.random() % 500, 100)
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
  let delay = Math.max(Math.random() % 500, 100)
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
): Promise<void> {
  value = ethers.BigNumber.from(value)
  console.log('Processing coin to token transaction', {
    to,
    value: value.toString(),
    targetChainId,
  })

  const chainProvider = chainProviders.get(targetChainId)
  if (!chainProvider) {
    console.error(`[ProcessCoinToToken] Chain provider not found for chainId ${targetChainId}`)
    return
  }

  const targetChainName = chainProvider.config.name
  console.log(`Processing transaction on ${targetChainName}`)

  await waitForBridgeCooldown(chainProvider, targetChainName)
  if (!checkMaxBridgeAmount(chainProvider, value, txId, targetChainName)) return

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

  // Use chain-specific keystore for signing
  let keyShare = await DKG(ourParty, targetChainId)
  const signedTx = await signEthereumTransaction(keyShare, tx, digest)
  if (!signedTx) {
    console.log(`Failed to sign Ethereum transaction on ${targetChainName}, skipping`, txId)
    return
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
    } else {
      console.log(
        `Transaction failed in execution - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      )
      sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, txHash)
    }
  } else {
    console.log(
      `Transaction failed - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      res.reason,
    )
    // Send tx status to coordinator
    sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, txHash, res.reason as string)
  }
}

async function processVaultBridge(
  to: string,
  value: ethers.BigNumber,
  txId: string,
  sourceChainId: number,
  destinationChainId: number,
): Promise<void> {
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
    return
  }

  const destChainProvider = chainProviders.get(destinationChainId)
  if (!destChainProvider) {
    console.error(`Destination chain provider not found for chainId ${destinationChainId}`)
    return
  }

  const sourceChainName = sourceChainProvider.config.name
  const destChainName = destChainProvider.config.name
  console.log(`Processing vault bridge: ${sourceChainName} -> ${destChainName}`)

  await waitForBridgeCooldown(destChainProvider, destChainName)
  if (!checkMaxBridgeAmount(destChainProvider, value, txId, destChainName)) return

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

  // Use destination chain's keystore for signing
  let keyShare = await DKG(ourParty, destinationChainId)
  const signedTx = await signEthereumTransaction(keyShare, tx, digest)
  if (!signedTx) {
    console.log(`Failed to sign EVM-to-EVM transaction on ${destChainName}, skipping`, txId)
    return
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
    } else {
      console.log(
        `EVM-to-EVM transaction failed in execution  - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      )
      sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, txHash)
    }
  } else {
    console.log(
      `EVM-to-EVM transaction failed - source tx ${txId} on ${sourceChainName} - dest tx ${txHash} on ${destChainName}`,
      res.reason,
    )
    sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, txHash, res.reason as string)
  }
}

async function processTokenToCoin(
  to: string,
  value: any,
  txId: string,
  sourceChainId: number,
): Promise<void> {
  console.log('Processing token to coin transaction', {to, value, txId, sourceChainId})

  const sourceChainProvider = chainProviders.get(sourceChainId)
  if (!sourceChainProvider) {
    console.error(`[ProcessTokenToCoin] Source chain provider not found for chainId ${sourceChainId}`)
    return
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

  // Use chain-specific keystore for signing (source chain for Liberdus transactions)
  let keyShare = await DKG(ourParty, sourceChainId)
  signedTx = await signLiberdusTransaction(keyShare, tx, digest)
  if (!signedTx) {
    console.log(`Failed to sign liberdus transaction from ${sourceChainName}, skipping`, txId)
    return
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
  } else if (receipt && receipt.success === false && receipt.reason) {
    console.log(
      `Transaction is failed - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId} with reason ${receipt.reason}`,
    )
    // Send tx status to coordinator
    sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, signedTxId, receipt.reason)
  } else {
    console.log(
      `Transaction is failed - ethereum tx ${txId} from ${sourceChainName} - liberdus tx ${signedTxId} with reason ${res.reason}`,
    )
    // Send tx status to coordinator
    sendTxStatusToCoordinator(txId, TransactionStatus.FAILED, signedTxId, res.reason as string)
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
    processingSetSize: processingTransactionIds.size,
    txQueueLength: txQueue.length,
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
  if (txQueueMap.size > 100) {
    console.warn(`⚠️ Large txQueueMap detected: ${txQueueMap.size} entries. Running emergency cleanup.`)
    emergencyCleanup()
  }
  
  if (processingTransactionIds.size > 10) {
    console.warn(`⚠️ Large processing set detected: ${processingTransactionIds.size} entries. Potential stuck transactions.`)
    cleanupStuckTransactions()
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
    queue: txQueue,
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
  
  // Count pending transactions before cleanup for reporting
  for (const [txId, txData] of txQueueMap.entries()) {
    if (txData.status === 'pending') {
      backupCount++
    }
  }
  
  // More aggressive cleanup - remove anything older than 1 hour regardless of status
  for (const [txId, txData] of txQueueMap.entries()) {
    const txAge = now - (txData.timestamp || serverStartTime)
    const oneHour = 60 * 60 * 1000
    
    if (txAge > oneHour) {
      txQueueMap.delete(txId)
      processingTransactionIds.delete(txId)
      removedCount++
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
  const now = Date.now()
  const stuckThreshold = 5 * 60 * 1000 // 5 minutes
  let cleanedCount = 0
  
  console.log('🔧 Cleaning up stuck transactions in processing set')
  
  for (const txId of processingTransactionIds) {
    const txData = txQueueMap.get(txId)
    
    if (!txData) {
      // Remove from processing set if not in map
      processingTransactionIds.delete(txId)
      cleanedCount++
      continue
    }
    
    const txAge = now - (txData.timestamp || 0)
    
    // If transaction has been processing for too long, consider it stuck
    if (txData.status === 'processing' && txAge > stuckThreshold) {
      console.warn(`⚠️ Found stuck transaction ${txId}, removing from processing set`)
      processingTransactionIds.delete(txId)
      
      // Update status to failed
      txData.status = 'failed'
      txData.timestamp = now
      
      cleanedCount++
    }
  }
  
  if (cleanedCount > 0) {
    console.log(`🔧 Cleaned up ${cleanedCount} stuck transactions`)
  }
}

async function confirmFutureTimestamp(operationId: string, timestamp: number): Promise<number> {
  const res = await axios.post(coordinatorUrl + '/future-timestamp', {
    key: operationId,
    value: timestamp,
  })
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

// Track which chains are currently reconnecting to prevent concurrent reconnects
const reconnectingChains: Set<number> = new Set()

function reconnectWebSocket(chainId: number) {
  const chainProvider = chainProviders.get(chainId)
  if (!chainProvider) return

  if (reconnectingChains.has(chainId)) return
  reconnectingChains.add(chainId)

  try {
    // Clean up old contract listeners
    if (chainProvider.contract) {
      chainProvider.contract.removeAllListeners('BridgedOut')
    }

    // Clean up old provider listeners
    if (chainProvider.wsProvider) {
      chainProvider.wsProvider.removeAllListeners()
      // @ts-ignore access raw websocket to clear low-level listeners
      if (chainProvider.wsProvider._websocket) {
        chainProvider.wsProvider._websocket.removeAllListeners?.()
        chainProvider.wsProvider._websocket.close?.()
      }
    }

    const wsUrl = chainProvider.config.wsUrl

    const newWsProvider = new ethers.providers.WebSocketProvider(wsUrl)
    chainProvider.wsProvider = newWsProvider

    // Attach low-level error/close handlers to trigger further reconnects
    newWsProvider.on('error', (error) => {
      console.error(`❌ WebSocket error for ${chainProvider.config.name}:`, error)
      reconnectWebSocket(chainId)
    })
    newWsProvider.on('close', () => {
      console.warn(`⚠️ WebSocket closed for ${chainProvider.config.name}, reconnecting...`)
      reconnectWebSocket(chainId)
    })
    newWsProvider.on('open', () => {
      console.log(`🟢 WebSocket connection opened for ${chainProvider.config.name}`)
    })

    console.log(`🔄 WebSocket reconnected for ${chainProvider.config.name}`)

    // Re-subscribe to events on the new provider
    subscribeToChainEvents(chainId)
  } catch (reconnectError) {
    console.error(`❌ Failed to reconnect WebSocket for ${chainProvider.config.name}:`, reconnectError)
  } finally {
    reconnectingChains.delete(chainId)
  }
}

// Add connection health monitoring with ping/pong keepalive
function monitorWebSocketHealth() {
  for (const [chainId, chainProvider] of chainProviders.entries()) {
    if (!chainProvider.wsProvider) continue

    try {
      // @ts-ignore access raw websocket for state check
      const rawWs = chainProvider.wsProvider._websocket
      if (rawWs && rawWs.readyState !== 1) {
        // readyState 1 = OPEN; anything else means dead/closing/connecting
        console.warn(`⚠️ WebSocket for ${chainProvider.config.name} not open (state: ${rawWs.readyState}), reconnecting...`)
        reconnectWebSocket(chainId)
        continue
      }

      // Send a ping to detect silent connection drops.
      // If the pong doesn't come back in 10s, the connection is stale.
      if (rawWs && typeof rawWs.ping === 'function') {
        let pongReceived = false
        const pongHandler = () => { pongReceived = true }
        rawWs.once('pong', pongHandler)
        rawWs.ping()

        setTimeout(() => {
          rawWs.removeListener('pong', pongHandler)
          if (!pongReceived) {
            console.warn(`⚠️ WebSocket for ${chainProvider.config.name} ping timeout, reconnecting...`)
            reconnectWebSocket(chainId)
          }
        }, 10000)
      } else {
        // Fallback: test via RPC call with a timeout
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 10000)
        )
        Promise.race([chainProvider.wsProvider.getBlockNumber(), timeout]).catch((error) => {
          console.warn(`⚠️ WebSocket for ${chainProvider.config.name} health check failed: ${error.message}, reconnecting...`)
          reconnectWebSocket(chainId)
        })
      }
    } catch (error) {
      console.error(`❌ Error monitoring WebSocket for ${chainProvider.config.name}:`, error)
    }
  }
}

function subscribeToChainEvents(chainId: number) {
  const chainProvider = chainProviders.get(chainId)
  if (!chainProvider || !chainProvider.wsProvider) return

  // Clean up old contract listeners to avoid duplicates after reconnection
  if (chainProvider.contract) {
    chainProvider.contract.removeAllListeners('BridgedOut')
  }

  const contractAddress = chainProvider.config.contractAddress
  const bridgeInterface = new ethersUtils.Interface([BRIDGE_OUT_EVENT_ABI])

  const contract = new ethers.Contract(
    contractAddress,
    bridgeInterface,
    chainProvider.wsProvider,
  )
  chainProvider.contract = contract
  const chainName = chainProvider.config.name

  contract.on(
    'BridgedOut',
    async (
      from: string,
      amount: ethers.BigNumber,
      targetAddress: string,
      parsedChainId: ethers.BigNumber,
      timestamp: ethers.BigNumber,
      event: ethers.Event,
    ) => {
      try {
        if (verboseLogs) {
          console.log(`BridgedOut event received from ${chainName}:`, {
            from,
            amount: amount.toString(),
            targetAddress,
            chainId: parsedChainId.toString(),
            txHash: event.transactionHash,
          })
        }

        // Debug: Log all event details for analysis
        console.log(`🔍 BridgedOut event analysis for ${chainName}:`, {
          eventChainId: parsedChainId.toNumber(),
          currentChainId: chainId,
          shouldProcess: parsedChainId.toNumber() === chainId,
          eventData: {
            from,
            targetAddress,
            amount: amount.toString(),
            timestamp: timestamp.toString(),
            blockNumber: event.blockNumber,
            txHash: event.transactionHash
          }
        });

        // Only process events from the current chain (for replay protection)
        if (parsedChainId.toNumber() !== chainId) {
          console.log(`❌ Skipping event: chainId mismatch (event: ${parsedChainId.toNumber()}, current: ${chainId}) on ${chainName}`)
          return
        }

        console.log(`✅ Processing valid bridge event on ${chainName}`);

        // Validate block number if needed
        if (!addOldTxToQueue && event.blockNumber < chainProvider.lastCheckedBlockNumber) {
          if (verboseLogs)
            console.log(`Event is older than the server start block for ${chainName}, skipping`)
          return
        }

        // Check if already in queue
        if (txQueueMap.has(event.transactionHash)) return

        // In vault mode, events on vaultChain → vaultBridge; in Liberdus mode → tokenToCoin
        const bridgeType: TransactionQueueItem['type'] =
          !chainConfigs.enableLiberdusNetwork ? 'vaultBridge' : 'tokenToCoin'

        const validTx: BridgeOutEvent = {
          from,
          amount,
          targetAddress,
          chainId: parsedChainId.toNumber(),
          txId: event.transactionHash,
        }

        const txData: TransactionQueueItem = {
          receipt: validTx,
          from: validTx.targetAddress,
          value: validTx.amount,
          txId: validTx.txId,
          type: bridgeType,
          chainId: chainId,
        }
        txQueue.push(txData)
        txQueueMap.set(validTx.txId, {
          status: 'pending',
          from: validTx.from,
          value: validTx.amount,
          txId: validTx.txId,
          chainId: chainId,
          timestamp: Date.now(),
        })
        saveQueueToFile(ourParty.idx)
        if (verboseLogs) {
          console.log(`BridgedOut event added to queue from ${chainName}:`, validTx)
        }
        sendTxDataToCoordinator(txData, timestamp.toNumber() * 1000)
      } catch (err) {
        console.error(`Error processing BridgedOut event from ${chainName}:`, err)
      }
    },
  )

  console.log(`📡 Subscribed to BridgedOut events on ${chainName} at ${contractAddress}`)
}

function subscribeEthereumTransactions() {
  if (!enableLocalMonitoring) return

  // Subscribe to events from all supported chains
  for (const [chainId, chainProvider] of chainProviders.entries()) {
    // In vault mode, only vaultChain emits events we subscribe to
    if (!chainConfigs.enableLiberdusNetwork && chainId === chainConfigs.secondaryChainConfig!.chainId) continue

    if (!chainProvider.wsProvider) {
      console.warn(`⚠️ No WebSocket provider available for ${chainProvider.config.name}, skipping event subscription`)
      continue
    }

    // Add WebSocket error handling and monitoring with reconnect
    chainProvider.wsProvider.on('error', (error) => {
      console.error(`❌ WebSocket error for ${chainProvider.config.name}:`, error)
      reconnectWebSocket(chainId)
    });

    chainProvider.wsProvider.on('close', () => {
      console.warn(`⚠️ WebSocket connection closed for ${chainProvider.config.name}`)
      reconnectWebSocket(chainId)
    });

    chainProvider.wsProvider.on('open', () => {
      console.log(`🟢 WebSocket connection opened for ${chainProvider.config.name}`)
    });

    // Subscribe to events for this chain
    subscribeToChainEvents(chainId)

    if (verboseLogs) {
      console.log(`📡 Subscribed to BridgedOut events from ${chainProvider.config.name} via WebSocket`)
      console.log(`📋 Contract address: ${chainProvider.config.contractAddress}`)
      console.log(`🔗 WebSocket URL: ${chainProvider.config.wsUrl}`)
    }
  }
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
      
      for (const chainIdStr of Object.keys(chainConfigs.supportedChains)) {
        const chainId = parseInt(chainIdStr)
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

  // set starting block number for all chains, resuming from saved state if available
  const savedBlockState = loadBlockState(ourParty.idx)
  for (const [chainId, chainProvider] of chainProviders.entries()) {
    try {
      const currentBlock = await chainProvider.provider.getBlockNumber()
      const savedBlock: number | undefined = savedBlockState?.[chainId.toString()] as number | undefined
      if (savedBlock != null && savedBlock < currentBlock) {
        chainProvider.lastCheckedBlockNumber = savedBlock
        console.log(`Resuming ${chainProvider.config.name} from saved block ${savedBlock} (current: ${currentBlock})`)
      } else if (savedBlock != null) {
        // Saved state exists but block is at or ahead of current — start at current
        chainProvider.lastCheckedBlockNumber = currentBlock
        console.log(`Starting ${chainProvider.config.name} at current block ${currentBlock}`)
      } else {
        // No saved state for this chain — start from the deployment block
        const deploymentBlock = chainProvider.config.deploymentBlock || 0
        chainProvider.lastCheckedBlockNumber = deploymentBlock
        console.log(`No saved block state for ${chainProvider.config.name}, starting from deployment block ${deploymentBlock} (current: ${currentBlock})`)
      }
    } catch (error) {
      console.error(`Failed to get starting block for ${chainProvider.config.name}:`, error)
    }
  }

  // Legacy compatibility
  if (loadExistingQueue) loadQueueFromFile(ourParty.idx)

  // One-time cleanup of any existing transactions that might not have timestamps
  console.log('🧹 Running one-time cleanup of existing transactions...')
  let fixedCount = 0
  for (const [txId, txData] of txQueueMap.entries()) {
    if (!txData.timestamp) {
      txData.timestamp = Date.now() - (24 * 60 * 60 * 1000) // Set to 24 hours ago so they get cleaned up
      fixedCount++
    }
  }
  if (fixedCount > 0) {
    console.log(`🔧 Fixed ${fixedCount} transactions without timestamps`)
    // Run immediate cleanup
    cleanupOldTransactions()
  }

  async function processTransaction(validTx: any): Promise<void> {
    const {txId} = validTx
    const startTime = Date.now()
    
    // Check if this transaction was recently completed to avoid duplicate processing
    if (isRecentlyCompleted(txId)) {
      console.log(`⏩ Transaction ${txId} was recently completed, skipping duplicate processing`)
      txQueueMap.set(txId, {
        status: 'completed',
        from: validTx.from,
        value: validTx.amount,
        txId: validTx.txId,
        chainId: validTx.chainId,
        timestamp: Date.now(),
      })
      processingTransactionIds.delete(txId)
      return
    }

    // Verify with coordinator that this tx hasn't already been completed/is being processed
    let coordinatorStatus: TransactionStatus | null = null
    try {
      coordinatorStatus = await checkTxStatusFromCoordinator(txId)
    } catch (error) {
      console.error(`Coordinator check failed for ${txId}, leaving in queue for later:`, error)
      return
    }
    if (coordinatorStatus === TransactionStatus.COMPLETED || coordinatorStatus === TransactionStatus.PROCESSING) {
      console.log(`⏩ Transaction ${txId} already has status ${coordinatorStatus === TransactionStatus.COMPLETED ? 'COMPLETED' : 'PROCESSING'} on coordinator, skipping`)
      txQueueMap.set(txId, {
        status: coordinatorStatus === TransactionStatus.COMPLETED ? 'completed' : 'processing',
        from: validTx.from,
        value: validTx.amount,
        txId: validTx.txId,
        chainId: validTx.chainId,
        timestamp: Date.now(),
      })
      processingTransactionIds.delete(txId)
      if (coordinatorStatus === TransactionStatus.COMPLETED) {
        markTransactionCompleted(txId)
      }
      return
    }

    try {
      let promises: Promise<any>[] = []
      if (validTx.type === 'coinToToken') {
        promises.push(
          processCoinToToken(
            validTx.from,
            validTx.value as ethers.BigNumber,
            validTx.txId,
            validTx.chainId,
          ),
        )
      } else if (validTx.type === 'tokenToCoin') {
        console.log('Processing token to coin transaction', validTx)
        promises.push(
          processTokenToCoin(
            validTx.from,
            validTx.value as ethers.BigNumber,
            validTx.txId,
            validTx.chainId,
          ),
        )
      } else if (validTx.type === 'vaultBridge') {
        console.log('Processing vault bridge (EVM-to-EVM) transaction', validTx)
        promises.push(
          processVaultBridge(
            validTx.from,
            validTx.value as ethers.BigNumber,
            validTx.txId,
            validTx.chainId,
            chainConfigs.secondaryChainConfig!.chainId,
          ),
        )
      }
      const threeMinPromise = 1000 * 60 * 1.5
      const failPromise = new Promise((resolve, reject) => {
        setTimeout(() => {
          reject(new Error('Transaction processing timed out'))
        }, threeMinPromise)
      })
      promises.push(failPromise)
      // wait for either the transaction to be processed or the timeout
      await Promise.race(promises)
      // if the transaction was processed successfully, remove it from the queue
      txQueueMap.set(validTx.txId, {
        status: 'completed',
        from: validTx.from,
        value: validTx.amount,
        txId: validTx.txId,
        chainId: validTx.chainId,
        timestamp: Date.now(), // Add timestamp for cleanup
      })
      console.log('Transaction processed successfully:', validTx)
      
      // Mark transaction as completed to prevent duplicate processing
      markTransactionCompleted(validTx.txId)
      
      // Check memory usage after successful transaction
      checkPostTransactionMemory(validTx.txId, 'transaction-success')
      
      // Force cleanup after successful transaction processing
      if (global.gc) {
        global.gc()
      }
    } catch (error: any) {
      if (error.message === enoughPartyError) {
        // Handle the "enough party" error - this means other parties already completed the signing
        console.log('Transaction already signed by enough parties, marking as completed:', validTx)
        txQueueMap.set(validTx.txId, {
          status: 'completed',
          from: validTx.from,
          value: validTx.amount,
          txId: validTx.txId,
          chainId: validTx.chainId,
          timestamp: Date.now(), // Add timestamp for cleanup
        })
        
        // Mark transaction as completed to prevent duplicate processing
        markTransactionCompleted(validTx.txId)
        
        // Additional cleanup for "enough party" scenarios to prevent memory leaks
        console.log('🧹 Performing cleanup after "enough party" error')
        checkPostTransactionMemory(validTx.txId, 'enough-party-error')
        if (global.gc) {
          global.gc()
        }
      } else if (error.message === 'Transaction processing timed out') {
        // Handle timeout errors more gracefully
        console.warn('⏱️ Transaction timed out, marking as failed and cleaning up:', validTx.txId)
        checkPostTransactionMemory(validTx.txId, 'timeout-error')
        txQueueMap.set(validTx.txId, {
          status: 'failed',
          from: validTx.from,
          value: validTx.amount,
          txId: validTx.txId,
          chainId: validTx.chainId,
          timestamp: Date.now(),
          error: 'timeout'
        })
        
        // Force cleanup after timeout
        if (global.gc) {
          global.gc()
        }
      } else {
        // Handle other errors
        console.error('❌ Error processing transaction:', error)
        txQueueMap.set(validTx.txId, {
          status: 'failed',
          from: validTx.from,
          value: validTx.amount,
          txId: validTx.txId,
          chainId: validTx.chainId,
          timestamp: Date.now(), // Add timestamp for cleanup
          error: error.message
        })
        
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
    // Clean up any stale transaction IDs that might have completed/failed but aren't reflected in our processing set
    for (const txId of processingTransactionIds) {
      const txStatus = txQueueMap.get(txId)
      if (txStatus && (txStatus.status === 'completed' || txStatus.status === 'failed')) {
        processingTransactionIds.delete(txId)
      }
    }

    // console.log(`Queue length: ${txQueue.length}`, processing);
    // Process new transactions while we have available slots
    while (txQueue.length > 0 && processingTransactionIds.size < MAX_CONCURRENT_TXS) {
      const validTx = txQueue.shift()!

      // Update transaction status to processing
      txQueueMap.set(validTx.txId, {
        status: 'processing', 
        ...validTx,
        timestamp: Date.now() // Update timestamp when moving to processing
      })
      saveQueueToFile(ourParty.idx)

      // Add to processing set
      processingTransactionIds.add(validTx.txId)

      // Start processing the transaction (fire and forget)
      processTransaction(validTx).catch((error) => {
        console.error(`Unexpected error in processTransaction for ${validTx.txId}:`, error)
        // Ensure cleanup happens even if there's an unexpected error
        processingTransactionIds.delete(validTx.txId)
      })
    }
    if (processingTransactionIds.size)
      console.log(
        `Currently processing ${processingTransactionIds.size} transactions, ${txQueue.length} in queue`,
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

  if (enableLocalMonitoring) {
    // Local monitoring: this party scans EVM chains and Liberdus directly
    if (chainConfigs.enableLiberdusNetwork) startDriftResistantScheduler(monitorLiberdusTransactions, liberdusTxMonitorInterval)
    startDriftResistantScheduler(monitorWebSocketHealth, 2 * 60 * 1000)
    const ethMonitorFn = useQueryFilter ? monitorEthereumTransactionsQueryFilter : monitorEthereumTransactions
    startDriftResistantScheduler(ethMonitorFn, ethereumTxMonitorInterval)
    subscribeEthereumTransactions()
  } else {
    // Coordinator-monitored mode: poll coordinator for pending transactions
    startDriftResistantScheduler(pollPendingTransactionsFromCoordinator, COORDINATOR_POLL_INTERVAL)
  }
}

main()
  .then(() => {
  })
  .catch((error) => {
    console.error('Fatal error in main:', error)
    process.exit(1)
  })
