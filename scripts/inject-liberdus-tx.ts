#!/usr/bin/env node
import {ethers} from 'ethers'
import * as crypto from '@shardus/crypto-utils'
import * as fs from 'node:fs'
import * as path from 'node:path'
import axios from 'axios'
import * as bnbTss from '../tss-tools/lib/bnbTss'
import {chainConfigsRaw} from '../shared/config'
import {
  DEFAULT_SHARDUS_CRYPTO_HASH_KEY,
  deriveDeterministicChannelId,
  deriveDeterministicChannelPassword,
} from '../tss-tools/lib/channelId'

const {stringify} = require(path.join(process.cwd(), 'external/stringify-shardus'))

type TxValue = string | number | bigint | boolean | null | undefined | TxObject | TxValue[]

type TxObject = {
  [key: string]: TxValue
}

type UnsignedLiberdusTx = TxObject & {
  from?: string
  to?: string
  type: string
  networkId?: string
  publicKey?: string
  timestamp?: number
  chatId?: string
}

type SignedLiberdusTx = UnsignedLiberdusTx & {
  sign: {
    owner: string
    sig: string
  }
}

type CliFlags = {
  [key: string]: string | boolean | undefined
}

type CycleRecord = {
  start: number
  duration: number
}

const CRYPTO_INIT_KEY = '69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc'
const proxyServerHost =
  process.env.LIBERDUS_PROXY_URL || chainConfigsRaw.proxyServerHost || 'https://dev.liberdus.com:3030'
const collectorHost = process.env.COLLECTOR_HOST || chainConfigsRaw.collectorHost || ''

const LIBERDUS_TIMESTAMP_STEP_MS = 30_000
const LIBERDUS_TIMESTAMP_MIN_FUTURE_MS = 60_000

crypto.init(CRYPTO_INIT_KEY)
crypto.setCustomStringifier(stringify, 'shardus_safeStringify')

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function usage(exitCode = 1): never {
  console.log(
    'Usage: npm run inject-liberdus-tx -- --chain-id <chainId> [--party <idx>] --tx-file <path> [--bigint-fields <fields>] [--cal-chatid] [options]',
  )
  console.log('       Omit --party to use the default-slot vault path.')
  console.log('')
  console.log('Options:')
  console.log('  --chain-id <id>           Chain id for the BNB TSS vault to use')
  console.log('  --party <idx>             Use explicit party-N vault layout')
  console.log('  --tx-file <path>          Path to the Liberdus tx JSON file')
  console.log('  --use-default-slot-path   Force default-slot vault layout when --party is omitted')
  console.log('  --password <value>        Override TSS vault password')
  console.log('  --vault <name>            Override vault name (default: "default")')
  console.log('  --home-root <path>        Override keystore root for BNB TSS')
  console.log('  --home-path <path>        Override exact vault home path for BNB TSS')
  console.log('  --channel-id <value>      Override BNB TSS signing channel id')
  console.log('  --channel-password <v>    Override BNB TSS signing channel password')
  console.log('  --sign-discovery-timeout <duration>')
  console.log('                            Native BNB TSS peer discovery window (default: 60s)')
  console.log('  --bigint-fields <fields>  Comma-separated tx fields to convert to BigInt')
  console.log('                            (default: "amount")')
  console.log('  --cal-chatid              Compute chatId from from+to and add it to the tx')
  console.log('  --dry-run                 Sign but do not inject')
  console.log('')
  console.log('Examples:')
  console.log('  npm run inject-liberdus-tx -- --chain-id 97 --tx-file ./liberdus-tx.json.example')
  console.log('  npm run inject-liberdus-tx -- --chain-id 97 --tx-file ./liberdus-tx.json.example --bigint-fields amount --cal-chatid')
  console.log('  npm run inject-liberdus-tx -- --chain-id 97 --party 1 --tx-file ./liberdus-tx.json.example --sign-discovery-timeout 60s')
  console.log('  npm run inject-liberdus-tx -- --chain-id 97 --tx-file ./liberdus-tx.json.example --dry-run')
  console.log('')
  console.log('transfer liberdus-tx.json.example example:')
  console.log(
    JSON.stringify(
      {
        from: '35576352aabcbce19aece1ffd376f7c49f022706000000000000000000000000',
        to: '<recipient-shardus-address>',
        amount: '1000000000000000000',
        type: 'transfer',
        networkId: chainConfigsRaw.liberdusNetworkId,
        memo: 'optional memo',
      },
      null,
      2,
    ),
  )
  process.exit(exitCode)
}

function toShardusAddress(address: string): string {
  if (address.length === 64) return address.toLowerCase()
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return address.slice(2).toLowerCase() + '0'.repeat(24)
  }
  return address
}

function isZeroAddressPlaceholder(address: string | undefined): boolean {
  if (!address) return true
  const normalized = address.trim().toLowerCase()
  return /^0x0{40}$/.test(normalized) || /^0{64}$/.test(normalized)
}

function deriveBnbTssIdentity(options: bnbTss.BasePartyOptions): {shardusAddress: string; publicKey: string} {
  const derived = bnbTss.derivePubkey({
    ...options,
    format: 'all',
  }) as {ethereum_address: string; ethereum_pubkey: string}
  return {
    shardusAddress: toShardusAddress(derived.ethereum_address),
    // Liberdus register expects the uncompressed secp256k1 public key without 0x.
    // bnbTss returns X+Y only, so add the uncompressed-key 04 prefix.
    publicKey: `04${derived.ethereum_pubkey}`,
  }
}

function calculateChatId(from: string, to: string): string {
  return crypto.hash([from, to].sort((a, b) => a.localeCompare(b)).join(''))
}

function stringifyWithBigInt(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) =>
    typeof currentValue === 'bigint' ? currentValue.toString() : currentValue,
  )
}

function deriveLocalFutureTimestamp(currentCycleRecord: CycleRecord): number {
  let futureTimestamp = currentCycleRecord.start * 1000 + currentCycleRecord.duration * 1000
  const minFuture = Date.now() + LIBERDUS_TIMESTAMP_MIN_FUTURE_MS
  while (futureTimestamp < minFuture) {
    futureTimestamp += LIBERDUS_TIMESTAMP_STEP_MS
  }
  return futureTimestamp
}

function verifySignedTx(tx: SignedLiberdusTx): boolean {
  const {owner, sig} = tx.sign
  const dataWithoutSign: TxObject = {...tx}
  delete dataWithoutSign.sign
  const message = crypto.hashObj(dataWithoutSign)
  const recoveredAddress = ethers.utils.verifyMessage(message, sig)
  const recoveredShardusAddress = toShardusAddress(recoveredAddress)
  const isValid = recoveredShardusAddress.toLowerCase() === owner.toLowerCase()
  console.log(`  Verification - owner: ${owner}`)
  console.log(`  Verification - recovered: ${recoveredShardusAddress}`)
  return isValid
}

async function injectLiberdusTx(txId: string, signedTx: SignedLiberdusTx): Promise<void> {
  const body = {tx: stringify(signedTx)}
  const injectUrl = `${proxyServerHost}/inject`
  const waitTime = (signedTx.timestamp || 0) - Date.now()

  if (waitTime > 0) {
    console.log(`Waiting ${Math.round(waitTime / 1000)}s for timestamp window...`)
    await sleep(waitTime)
  }

  console.log(`Injecting tx ${txId} -> ${injectUrl}`)
  const response = await axios.post(injectUrl, body)
  console.log('Inject response:', JSON.stringify(response.data))
  if (response.status !== 200 || response.data?.result?.success !== true) {
    throw new Error(`Injection rejected: ${JSON.stringify(response.data)}`)
  }
}

async function pollForReceipt(txId: string, maxRetries = 10): Promise<any | null> {
  const url = `${proxyServerHost}/transaction/${txId}`
  for (let i = 0; i < maxRetries; i += 1) {
    await sleep(2000)
    try {
      const response = await axios.get(url)
      if (response.data && response.data.transaction) return response.data.transaction
    } catch {
      // keep polling
    }
    console.log(`  Polling receipt... attempt ${i + 1}/${maxRetries}`)
  }
  return null
}

async function getLatestCycleRecord(): Promise<CycleRecord> {
  if (!collectorHost) {
    throw new Error('COLLECTOR_HOST or chainConfigs.collectorHost is required to derive timestamp from cycle')
  }
  const url = `${collectorHost}/api/cycleinfo?count=1`
  const response = await axios.get(url)
  const {success, cycles} = response.data || {}
  const cycleRecord = success && Array.isArray(cycles) && cycles.length > 0 ? cycles[0].cycleRecord : null
  if (
    !cycleRecord ||
    !Number.isFinite(cycleRecord.start) ||
    !Number.isFinite(cycleRecord.duration)
  ) {
    throw new Error(`Failed to load latest cycle record from ${url}`)
  }
  return {
    start: cycleRecord.start,
    duration: cycleRecord.duration,
  }
}

function parseArgs(argv: string[]): {positional: string[]; flags: CliFlags} {
  const positional: string[] = []
  const flags: CliFlags = {}
  const booleanFlags = new Set(['cal-chatid', 'dry-run', 'use-default-slot-path'])
  const valueFlags = new Set([
    'chain-id',
    'party',
    'tx-file',
    'password',
    'vault',
    'home-root',
    'home-path',
    'channel-id',
    'channel-password',
    'sign-discovery-timeout',
    'bigint-fields',
  ])

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else if (booleanFlags.has(arg.slice(2))) {
        flags[arg.slice(2)] = true
      } else if (valueFlags.has(arg.slice(2))) {
        flags[arg.slice(2)] = argv[i + 1]
        i += 1
      } else {
        console.error(`Unknown argument: ${arg}`)
        usage()
      }
      continue
    }
    positional.push(arg)
  }

  return {positional, flags}
}

function requireStringFlag(flags: CliFlags, key: string): string | undefined {
  const value = flags[key]
  return typeof value === 'string' ? value : undefined
}

function asUnsignedLiberdusTx(value: unknown): UnsignedLiberdusTx {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Transaction JSON must be an object')
  }
  return value as UnsignedLiberdusTx
}

async function main(): Promise<void> {
  const {flags} = parseArgs(process.argv.slice(2))
  const chainIdArg = requireStringFlag(flags, 'chain-id')
  const txFileArg = requireStringFlag(flags, 'tx-file')

  if (!chainIdArg || !txFileArg) {
    usage()
  }

  const chainId = Number.parseInt(chainIdArg, 10)
  if (!Number.isInteger(chainId)) {
    throw new Error(`Invalid chainId: "${chainIdArg}"`)
  }

  const txFilePath = path.resolve(txFileArg)
  if (!fs.existsSync(txFilePath)) {
    throw new Error(`Tx file not found: ${txFilePath}`)
  }

  const partyFlag = requireStringFlag(flags, 'party')
  const partyIdx = partyFlag != null ? Number.parseInt(partyFlag, 10) : undefined
  const useDefaultSlotPath = flags['use-default-slot-path'] === true || partyFlag == null

  if (partyFlag != null && (!Number.isInteger(partyIdx) || partyIdx < 1)) {
    throw new Error(`Invalid --party value: "${partyFlag}"`)
  }

  const bigintFields = (requireStringFlag(flags, 'bigint-fields') || 'amount')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)
  const calChatId = flags['cal-chatid'] === true
  const dryRun = flags['dry-run'] === true

  const tx = asUnsignedLiberdusTx(JSON.parse(fs.readFileSync(txFilePath, 'utf8')))

  if (!tx.type) {
    throw new Error('Missing required tx field: "type"')
  }

  if (!tx.networkId) {
    tx.networkId = chainConfigsRaw.liberdusNetworkId
    console.log(`Defaulted tx.networkId from chain-config.json: ${tx.networkId}`)
  }

  let bnbTssIdentity: {shardusAddress: string; publicKey: string} | undefined
  const getBnbTssIdentity = (): {shardusAddress: string; publicKey: string} => {
    if (!bnbTssIdentity) {
      bnbTssIdentity = deriveBnbTssIdentity({
        ...(useDefaultSlotPath ? {} : {partyIdx}),
        chainId,
        useDefaultSlotPath,
        password: requireStringFlag(flags, 'password'),
        vaultName: requireStringFlag(flags, 'vault'),
        homeRoot: requireStringFlag(flags, 'home-root'),
        homePath: requireStringFlag(flags, 'home-path'),
      })
    }
    return bnbTssIdentity
  }

  if (isZeroAddressPlaceholder(tx.from)) {
    tx.from = getBnbTssIdentity().shardusAddress
    console.log(`Defaulted tx.from from BNB TSS vault: ${tx.from}`)
  } else {
    tx.from = toShardusAddress(tx.from!)
  }

  if (tx.type === 'register' && !tx.publicKey) {
    tx.publicKey = getBnbTssIdentity().publicKey
    console.log(`Defaulted tx.publicKey from BNB TSS vault: ${tx.publicKey}`)
  }

  if (typeof tx.to === 'string') {
    tx.to = toShardusAddress(tx.to)
  }

  if (tx.type === 'register') {
    tx.aliasHash = crypto.hash(`${tx.alias || ''}`)
  }

  for (const field of bigintFields) {
    if (tx[field] != null) {
      tx[field] = BigInt(`${tx[field]}`)
      console.log(`Converted tx.${field} to BigInt`)
    }
  }

  if (calChatId && typeof tx.to === 'string') {
    tx.chatId = calculateChatId(tx.from, tx.to)
    console.log(`Computed chatId: ${tx.chatId}`)
  }

  if (!tx.timestamp) {
    const currentCycleRecord = await getLatestCycleRecord()
    tx.timestamp = deriveLocalFutureTimestamp(currentCycleRecord)
  }

  console.log(`Timestamp: ${tx.timestamp} (${new Date(tx.timestamp).toISOString()})`)
  console.log('\n-- Transaction ----------------------------------------------')
  console.log(stringifyWithBigInt(tx))
  console.log(`\nChainId:      ${chainId}`)
  console.log(`Proxy:        ${proxyServerHost}`)
  console.log(`Vault Path Mode:   ${useDefaultSlotPath ? 'default-slot' : `party-${partyIdx}`}`)

  const hashMessage = crypto.hashObj(tx)
  const digest = ethers.utils.hashMessage(hashMessage)
  const unsignedTxId = crypto.hashObj(tx)
  const channelId =
    requireStringFlag(flags, 'channel-id') ||
    process.env.BNB_TSS_CHANNEL_ID ||
    deriveDeterministicChannelId(unsignedTxId, tx.timestamp)
  const channelPassword =
    requireStringFlag(flags, 'channel-password') ||
    process.env.BNB_TSS_CHANNEL_PASSWORD ||
    deriveDeterministicChannelPassword(
      channelId,
      (process.env.SHARDUS_CRYPTO_HASH_KEY || DEFAULT_SHARDUS_CRYPTO_HASH_KEY).trim(),
    )

  console.log(`\nHash message:  ${hashMessage}`)
  console.log(`Digest:        ${digest}`)
  console.log(`Unsigned tx ID:${unsignedTxId}`)
  console.log(`Channel ID:    ${channelId}`)

  console.log('\n-- BNB TSS Signing ------------------------------------------')
  console.log('Run this command on enough parties at the same time for threshold signing.')

  const signed = await bnbTss.signDigest({
    ...(useDefaultSlotPath ? {} : {partyIdx}),
    chainId,
    useDefaultSlotPath,
    digest,
    channelId,
    channelPassword,
    password: requireStringFlag(flags, 'password'),
    vaultName: requireStringFlag(flags, 'vault'),
    homeRoot: requireStringFlag(flags, 'home-root'),
    homePath: requireStringFlag(flags, 'home-path'),
    signDiscoveryTimeout: requireStringFlag(flags, 'sign-discovery-timeout') || '60s',
    printLogs: true,
  })

  const signature = {
    r: signed.r,
    s: signed.s,
    v: signed.v,
  }
  const serializedSignature = ethers.utils.joinSignature(signature)

  const signedTx: SignedLiberdusTx = {
    ...tx,
    sign: {
      owner: tx.from,
      sig: serializedSignature,
    },
  }

  console.log('\n-- Verifying signature --------------------------------------')
  const isValid = verifySignedTx(signedTx)
  console.log(`Signature valid: ${isValid}`)
  if (!isValid) {
    throw new Error('Signature verification failed')
  }

  const txId = crypto.hashObj(signedTx, true)
  console.log(`\nSigned tx ID: ${txId}`)
  console.log('Signed tx:', stringifyWithBigInt(signedTx))

  if (dryRun) {
    console.log('\n-- Dry run --------------------------------------------------')
    return
  }

  console.log('\n-- Injecting to Liberdus network ----------------------------')
  await injectLiberdusTx(txId, signedTx)

  console.log('\n-- Waiting for receipt --------------------------------------')
  const receipt = await pollForReceipt(txId)
  if (receipt) {
    if (receipt.success === true) {
      console.log('Transaction confirmed!')
    } else {
      console.log('Transaction failed on-chain:', receipt.reason || 'unknown reason')
    }
    console.log('Receipt:', JSON.stringify(receipt, null, 2))
    return
  }

  console.log('No receipt within polling window. Verify manually:')
  console.log(`  ${proxyServerHost}/transaction/${txId}`)
}

Promise.resolve(main()).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
