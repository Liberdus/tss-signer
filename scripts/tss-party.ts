import {ethers} from 'ethers'
import * as fs from 'fs'
import * as path from 'path'
import axios, {AxiosResponse} from 'axios'
import * as crypto from '@shardus/crypto-utils'
import * as readline from 'readline-sync'
import {toEthereumAddress, toShardusAddress} from './transformAddress'

const {BigNumber, utils: ethersUtils, providers} = ethers

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
}

interface ChainConfigs {
  supportedChains: Record<string, ChainConfig>
  defaultChain: number
  liberdusNetworkId: string
}

interface ChainProviders {
  provider: ethers.providers.JsonRpcProvider
  wsProvider: ethers.providers.WebSocketProvider
  config: ChainConfig
  lastCheckedBlockNumber: number
}

interface TransactionQueueItem {
  receipt: any
  from: string
  value: ethers.BigNumber | bigint
  txId: string
  type: 'tokenToCoin' | 'coinToToken'
  chainId: number // Add chainId to track which chain this transaction belongs to
}

interface TxQueueMapValue {
  status: 'pending' | 'processing' | 'completed' | 'failed'
  from: string
  value: ethers.BigNumber | bigint
  txId: string
  chainId?: number // Add chainId to track which chain this transaction belongs to
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
  memo: string
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
  receipt: string
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
  BRIDGE_IN = 0, // COIN to TOKEN
  BRIDGE_OUT = 1, // TOKEN to COIN
}

const parsedIdx = process.argv[2]
const operationFlag = process.argv[3]

const generateKeystore = operationFlag === '--keygen'
const verifyKeystores = operationFlag === '--verify'
const loadExistingQueue = true
const verboseLogs = true
const addOldTxToQueue = false

const serverStartTime = Date.now()

let params: Params = loadParams()
let chainConfigs: ChainConfigs = loadChainConfigs()
let t = params.threshold
let n = params.parties

const infuraKeys = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../', 'infura_keys.json'), 'utf8'),
)

const coordinatorUrl = 'http://127.0.0.1:8000'
const collectorHost = 'http://127.0.0.1:6001'
const proxyServerHost = 'https://dev.liberdus.com:3030'

const tssPartyIdx =
  parsedIdx == null ? readline.question('Enter the party index (1 to 5): ') : parsedIdx
const ourParty: KeyShare = {idx: parseInt(tssPartyIdx), res: ''}

const ourInfurKey = infuraKeys[parseInt(tssPartyIdx) - 1]

// Initialize providers for all supported chains
const chainProviders: Map<number, ChainProviders> = new Map()

// Setup providers for each supported chain
for (const [chainIdStr, config] of Object.entries(chainConfigs.supportedChains)) {
  const chainId = parseInt(chainIdStr)
  const rpcUrl = config.rpcUrl.includes('infura.io')
    ? `${config.rpcUrl}${ourInfurKey}`
    : config.rpcUrl

  const provider = new providers.JsonRpcProvider(rpcUrl)

  // Only create WebSocket provider if not in keygen mode and URL is valid
  let wsProvider: ethers.providers.WebSocketProvider | null = null
  if (!generateKeystore) {
    try {
      const wsUrl = config.wsUrl.includes('infura.io') ? `${config.wsUrl}${ourInfurKey}` : config.wsUrl
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
  })

  console.log(`HTTP provider initialized for ${config.name} (Chain ID: ${chainId})`)
}

// Legacy variables for backward compatibility (using default chain)
const defaultChainProvider = chainProviders.get(chainConfigs.defaultChain)!
const provider = defaultChainProvider.provider
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
const txQueueProcessingInterval = 3000
const liberdusTxMonitorInterval = 5000
const ethereumTxMonitorInterval = 10000

// Define maximum concurrent transactions
const MAX_CONCURRENT_TXS = 1
const processingTransactionIds = new Set<string>()

const delay_ms = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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
  for (const chainIdStr of Object.keys(chainConfigs.supportedChains)) {
    const chainId = parseInt(chainIdStr)
    if (keystoreExists(partyIdx, chainId)) {
      chainIds.push(chainId)
    }
  }

  return chainIds
}

// New function to ensure all chain keystores exist for a party
const ensureChainKeystores = async (partyIdx: number): Promise<Map<number, string>> => {
  const keystores = new Map<number, string>()

  for (const chainIdStr of Object.keys(chainConfigs.supportedChains)) {
    const chainId = parseInt(chainIdStr)

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
    
    const publicKeyX = publicKeyData.x
    const publicKeyY = publicKeyData.y
    
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
    const chainConfig = chainConfigs.supportedChains[chainId.toString()]
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
    console.log(`Chain provider not found for chainId ${targetChainId}`)
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
  if (receipt.to?.toLowerCase() !== chainProvider.config.contractAddress.toLowerCase()) {
    console.log(`Transaction is not for the ${chainProvider.config.name} contract address`)
    return false
  }
  const bridgeInterface = new ethersUtils.Interface([
    'event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)',
  ])
  const bridgeOutLog = receipt.logs.find((log: any) => {
    try {
      if (log.address.toLowerCase() !== chainProvider.config.contractAddress.toLowerCase())
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
  console.log('BridgedOut event data:', {
    from,
    amount: amount.toString(),
    targetAddress,
    chainId: parsedChainId,
  })

  // Validate that the chainId in the event matches Liberdus chain (should be a special chainId for Liberdus)
  // For now, we accept any valid chainId that's not the current EVM chain
  if (parsedChainId === targetChainId) {
    console.log('Transaction is trying to bridge to the same chain')
    return false
  }

  return {
    from: from,
    targetAddress: targetAddress,
    amount: amount,
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
  const oneEtherInBigInt = ethersUtils.parseEther('1.0')
  if (transferAmountInBigInt.lt(oneEtherInBigInt)) {
    console.log('Transaction value is less than 1 LIB')
    return false
  }
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
  let context = await m.gg18_sign_client_new_context(
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
  return sign_json
}

async function monitorEthereumTransactions(): Promise<void> {
  // Monitor all supported EVM chains
  for (const [chainId, chainProvider] of chainProviders.entries()) {
    try {
      console.log(
        `Monitoring Ethereum transactions for bridgeOut calls on ${chainProvider.config.name}...`,
      )
      const newestBlockNumber = await chainProvider.provider.getBlockNumber()
      console.log(`Newest block number for ${chainProvider.config.name}:`, newestBlockNumber)

      if (chainProvider.lastCheckedBlockNumber >= newestBlockNumber) {
        console.log(
          `This block has already been checked for ${chainProvider.config.name}, skipping...`,
          chainProvider.lastCheckedBlockNumber,
          newestBlockNumber,
        )
        continue
      }

      for (let i = chainProvider.lastCheckedBlockNumber + 1; i <= newestBlockNumber; i++) {
        const block = await chainProvider.provider.getBlockWithTransactions(i)
        console.log(`Processing block ${i} on ${chainProvider.config.name}`, block.number)
        console.log('Found block with transactions:', block.transactions.length)

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
          const txData: TransactionQueueItem = {
            receipt: validTx,
            from: validTx.targetAddress,
            value: validTx.amount,
            txId: validTx.txId,
            type: 'tokenToCoin',
            chainId: chainId,
          }
          txQueue.push(txData)
          txQueueMap.set(validTx.txId, {
            status: 'pending',
            from: validTx.from,
            value: validTx.amount,
            txId: validTx.txId,
            chainId: chainId,
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
      }
    } catch (error) {
      console.error(
        `Error monitoring Ethereum transactions on ${chainProvider.config.name}:`,
        error,
      )
    }
  }
}

async function monitorLiberdusTransactions(): Promise<void> {
  console.log('Running monitorLiberdusTransactions', new Date().toISOString())
  try {
    // Query for transactions to all bridge addresses
    const bridgeAddresses = Object.values(chainConfigs.supportedChains).map(
      (config) => config.bridgeAddress,
    )

    for (const bridgeAddress of bridgeAddresses) {
      console.log('Updated lastCheckedTimestamp:', new Date(lastCheckedTimestamp).toISOString())
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
            })
            saveQueueToFile(ourParty.idx)
            if (verboseLogs) {
              const targetChainName =
                chainConfigs.supportedChains[validateResult.targetChainId.toString()]?.name ||
                'Unknown'
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
    type: txData.type === 'coinToToken' ? TransactionType.BRIDGE_IN : TransactionType.BRIDGE_OUT,
    txTimestamp: timestamp,
    status: TransactionStatus.PENDING,
    receipt: '',
    party: ourParty.idx,
    chainId: txData.chainId, // Include chain information
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
      const chainName = txData.chainId
        ? chainConfigs.supportedChains[txData.chainId.toString()]?.name || 'Unknown'
        : 'Legacy'
      console.log(`Sent txData to coordinator (${chainName}):`, response.data)
    }
  } catch (error) {
    console.error('Error sending txData to coordinator:', error)
  }
}

async function sendTxStatusToCoordinator(
  txId: string,
  status: TransactionStatus,
  receipt: string,
  failedReason = '',
): Promise<void> {
  try {
    const url = `${coordinatorUrl}/transaction/status`
    const data: TxStatusData = {txId, status, receipt, reason: failedReason, party: ourParty.idx}
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
  if (verboseLogs) {
    console.log('Liberdus transaction signed successfully!', signedTx)
  }
  return signedTx
}

async function injectEthereumTx(
  txHash: string,
  signedTx: string,
  targetProvider?: ethers.providers.JsonRpcProvider,
): Promise<{ success: boolean; reason?: string }> {
  const providerToUse = targetProvider || provider
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
    await sleep(10000)
    const receipt = await getLiberdusReceipt(res.data.result.txId, 30)
    if (receipt && receipt.success === false) throw new Error('Transaction failed')
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
  console.log('Processing coin to token transaction', {
    to,
    value: value.toString(),
    targetChainId,
  })

  const chainProvider = chainProviders.get(targetChainId)
  if (!chainProvider) {
    console.error(`Chain provider not found for chainId ${targetChainId}`)
    return
  }

  const targetChainName = chainProvider.config.name
  console.log(`Processing transaction on ${targetChainName}`)

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

  const bridgeInterface = new ethersUtils.Interface([
    'function bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId) public',
  ])
  const txIdBytes32 = '0x' + txId
  const data = bridgeInterface.encodeFunctionData('bridgeIn', [
    '0x' + to.slice(0, 40),
    value,
    targetChainId, // Use the target chain ID
    txIdBytes32,
  ])
  const tx = {
    to: chainProvider.config.contractAddress,
    value: 0,
    data,
    nonce: senderNonce,
    gasLimit: chainProvider.config.gasConfig.gasLimit,
    gasPrice: currentGasPrice,
    chainId: targetChainId,
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
  }

  const receipt = await chainProvider.provider.getTransactionReceipt(txHash)
  if (receipt && receipt.status === 1) {
    console.log(
      `Transaction is successful - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
    )
    // Send tx status to coordinator
    sendTxStatusToCoordinator(txId, TransactionStatus.COMPLETED, txHash)
  } else {
    console.log(
      `Transaction failed - liberdus tx ${txId} - ethereum tx ${txHash} on ${targetChainName}`,
      res.reason,
    )
    // Send tx status to coordinator
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
    console.error(`Source chain provider not found for chainId ${sourceChainId}`)
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
    memo: `${txId}:${sourceChainId}`, // Include source chain info in memo
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

  const receipt = await getLiberdusReceipt(signedTxId, 2)
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
    shouldRetry = (error: Error) =>
      !error.message.includes('invalid signature') &&
      !error.message.includes('Nonce too low') &&
      !error.message.includes('Transaction Failed'),
  } = options

  let lastError: Error

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error as Error

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

function subscribeEthereumTransactions() {
  const bridgeInterface = new ethersUtils.Interface([
    'event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)',
  ])

  // Subscribe to events from all supported chains
  for (const [chainId, chainProvider] of chainProviders.entries()) {
    const contract = new ethers.Contract(
      chainProvider.config.contractAddress,
      bridgeInterface,
      chainProvider.wsProvider,
    )
    const chainName = chainProvider.config.name

    contract.on(
      'BridgedOut',
      async (
        from: string,
        amount: ethers.BigNumber,
        targetAddress: string,
        parsedChainId: ethers.BigNumber,
        timestamp: ethers.BigNumber,
        event: any,
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
          // The chainId in the event should match the current EVM chain ID
          if (parsedChainId.toNumber() !== chainId) {
            console.log(`❌ Skipping event: chainId mismatch (event: ${parsedChainId.toNumber()}, current: ${chainId}) on ${chainName}`)
            return
          }

          console.log(`✅ Processing valid bridge event on ${chainName}`);

          // Check if target chain is Liberdus (we might need to define a special chainId for Liberdus)
          // For now, accept any chainId that's different from the source chain

          // Validate block number if needed
          if (!addOldTxToQueue && event.blockNumber < chainProvider.lastCheckedBlockNumber) {
            if (verboseLogs)
              console.log(`Event is older than the server start block for ${chainName}, skipping`)
            return
          }

          // Check if already in queue
          if (txQueueMap.has(event.transactionHash)) return

          // Add to queue
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
            type: 'tokenToCoin',
            chainId: chainId, // Source chain where the event originated
          }
          txQueue.push(txData)
          txQueueMap.set(validTx.txId, {
            status: 'pending',
            from: validTx.from,
            value: validTx.amount,
            txId: validTx.txId,
            chainId: chainId,
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

    // Add WebSocket error handling and monitoring
    if (chainProvider.wsProvider) {
      chainProvider.wsProvider.on('error', (error) => {
        console.error(`❌ WebSocket error for ${chainName}:`, error);
      });

      chainProvider.wsProvider.on('close', () => {
        console.warn(`⚠️ WebSocket connection closed for ${chainName}`);
      });

      chainProvider.wsProvider.on('open', () => {
        console.log(`🟢 WebSocket connection opened for ${chainName}`);
      });
    }

    if (verboseLogs) {
      console.log(`📡 Subscribed to BridgedOut events from ${chainName} via WebSocket`)
      console.log(`📋 Contract address: ${chainProvider.config.contractAddress}`)
      console.log(`🔗 WebSocket URL: ${chainProvider.config.wsUrl}`)
    }
  }
}

async function main(): Promise<void> {
  // Show help if no valid operation flag is provided
  if (!generateKeystore && !verifyKeystores && !process.argv[3]) {
    console.log('\nUsage: ts-node scripts/tss-party.ts <party_index> <operation>')
    console.log('\nOperations:')
    console.log('  --keygen  : Generate new keystores for all supported chains (pure key generation)')
    console.log('  --verify  : Verify and test existing keystores, display EOA addresses')
    console.log('  (none)    : Start normal TSS party operation (requires existing keystores)')
    console.log('\nExamples:')
    console.log('  ts-node scripts/tss-party.ts 1 --keygen   # Generate keystores for party 1')
    console.log('  ts-node scripts/tss-party.ts 1 --verify   # Verify keystores for party 1')
    console.log('  ts-node scripts/tss-party.ts 1            # Start party 1 for TSS operations')
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
        const chainConfig = chainConfigs.supportedChains[chainId.toString()]
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
        
        console.log(`  🌐 RPC URL: ${chainConfig.rpcUrl}`)
        console.log(`  📋 Contract: ${chainConfig.contractAddress}`)
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

  // set starting block number for all chains
  for (const [chainId, chainProvider] of chainProviders.entries()) {
    try {
      const currentBlock = await chainProvider.provider.getBlockNumber()
      chainProvider.lastCheckedBlockNumber = currentBlock
      console.log(`Starting block for ${chainProvider.config.name}: ${currentBlock}`)
    } catch (error) {
      console.error(`Failed to get starting block for ${chainProvider.config.name}:`, error)
    }
  }

  // Legacy compatibility
  if (loadExistingQueue) loadQueueFromFile(ourParty.idx)

  async function processTransaction(validTx: any): Promise<void> {
    const {txId} = validTx
    const startTime = Date.now()
    try {
      let promises: Promise<any>[] = []
      if (validTx.type === 'coinToToken') {
        promises.push(
          processCoinToToken(
            validTx.from,
            validTx.value as ethers.BigNumber,
            validTx.txId,
            validTx.chainId || chainConfigs.defaultChain,
          ),
        )
      } else if (validTx.type === 'tokenToCoin') {
        console.log('Processing token to coin transaction', validTx)
        promises.push(
          processTokenToCoin(
            validTx.from,
            validTx.value as ethers.BigNumber,
            validTx.txId,
            validTx.chainId || chainConfigs.defaultChain,
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
      })
      console.log('Transaction processed successfully:', validTx)
    } catch (error: any) {
      if (error.message === enoughPartyError) {
        // todo: check if the tx is actually signed by enough parties and injected properly
        console.log('Transaction already signed by enough parties, skipping:', validTx)
        txQueueMap.set(validTx.txId, {
          status: 'completed',
          from: validTx.from,
          value: validTx.amount,
          txId: validTx.txId,
          chainId: validTx.chainId,
        })
      } else {
        // todo: find better way to handle errors
        // txQueue.push(validTx);
        txQueueMap.set(validTx.txId, {
          status: 'failed',
          from: validTx.from,
          value: validTx.amount,
          txId: validTx.txId,
          chainId: validTx.chainId,
        })
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
      txQueueMap.set(validTx.txId, {status: 'processing', ...validTx})
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
  startDriftResistantScheduler(monitorLiberdusTransactions, liberdusTxMonitorInterval)
  // startDriftResistantScheduler(monitorEthereumTransactions, ethereumTxMonitorInterval);
  subscribeEthereumTransactions()
}

main()
  .then(() => {
  })
  .catch((error) => {
  })
