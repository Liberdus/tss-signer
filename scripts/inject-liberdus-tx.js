#!/usr/bin/env node
/**
 * inject-liberdus-tx.js
 *
 * Manually sign a Liberdus transaction using all 5 TSS party keystores
 * and inject it into the Liberdus network.
 *
 * Prerequisites:
 *   - WASM built: npm run build_node
 *   - Coordinator running at coordinatorUrl (default: http://127.0.0.1:8000)
 *
 * Usage:
 *   node scripts/inject-liberdus-tx.js <chainId> <tx-json-file>
 *
 * Example:
 *   node scripts/inject-liberdus-tx.js 80002 ./tx.json
 *
 * Environment variables:
 *   COORDINATOR_URL     Override coordinator URL (default: from chain-config.json)
 *   LIBERDUS_PROXY_URL  Override proxy URL for injection (default: https://dev.liberdus.com:3030)
 *
 * tx.json — required fields for ALL types:
 *   { "from": "<shardus 64-char hex>", "type": "<tx-type>", ... }
 *
 * Type-specific notes:
 *   transfer   — also needs: to, amount (decimal string), networkId, memo
 *                timestamp: use the provided value, or Date.now() if omitted —
 *                frozen before signing so all 5 parties hash the same object
 *                pass --cal-chatid to compute chatId from from+to automatically
 *   <other>    — include whatever fields the network expects; the script signs
 *                the whole object without restricting which fields are present.
 *
 * BigInt fields: any field listed in --bigint-fields (comma-separated) will be
 *   converted from decimal string → BigInt before hashing.
 *   Default bigint fields: amount
 *   Example: --bigint-fields amount,fee
 */

'use strict'

const gg18 = require('../pkg')
const ethers = require('ethers')
const crypto = require('@shardus/crypto-utils')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const {stringify} = require('../external/stringify-shardus')

// ─── Init ────────────────────────────────────────────────────────────────────

const CRYPTO_INIT_KEY = '69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc'
const KEYSTORE_DIR = path.join(__dirname, '../keystores')

crypto.init(CRYPTO_INIT_KEY)
crypto.setCustomStringifier(stringify, 'shardus_safeStringify')

const params = JSON.parse(fs.readFileSync(path.join(__dirname, '../params.json'), 'utf8'))
const chainConfigs = JSON.parse(fs.readFileSync(path.join(__dirname, '../chain-config.json'), 'utf8'))

const t = params.threshold
const n = params.parties

const coordinatorUrl =
  process.env.COORDINATOR_URL || chainConfigs.coordinatorUrl || 'http://127.0.0.1:8000'

const enableShardusCryptoAuth =
  process.env.ENABLE_SHARDUS_CRYPTO_AUTH != null
    ? process.env.ENABLE_SHARDUS_CRYPTO_AUTH === 'true'
    : chainConfigs.enableShardusCryptoAuth === true
const signerKeyStoreDir = path.join(__dirname, '../keystores')
const signerKeyPairFilePathFromEnv = (process.env.TSS_SIGNER_KEYPAIR_FILE || '').trim()
const signerPartyIdx = parseInt((process.env.TSS_PARTY_IDX || process.argv[4] || '1').toString(), 10)

function isHexWithLength(value, length) {
  return typeof value === 'string' && value.length === length && /^[0-9a-fA-F]+$/.test(value)
}

function loadSignerKeyPairFromFile(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
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

function resolveSignerKeyPairFilePath(partyIdx) {
  if (signerKeyPairFilePathFromEnv) return signerKeyPairFilePathFromEnv
  const partySpecificPath = path.join(signerKeyStoreDir, `tss-signer-keypair_party_${partyIdx}.json`)
  if (fs.existsSync(partySpecificPath)) return partySpecificPath
  return path.join(signerKeyStoreDir, 'tss-signer-keypair.json')
}

if (enableShardusCryptoAuth && typeof gg18.gg18_shardus_crypto_init === 'function') {
  const shardusCryptoHashKey = (process.env.SHARDUS_CRYPTO_HASH_KEY || '').trim()
  if (!shardusCryptoHashKey) {
    throw new Error('[auth] SHARDUS_CRYPTO_HASH_KEY is required when ENABLE_SHARDUS_CRYPTO_AUTH=true')
  }

  const signerKeyPairFilePath = resolveSignerKeyPairFilePath(signerPartyIdx)
  const fileKeyPair = loadSignerKeyPairFromFile(signerKeyPairFilePath)
  const signerPublicKey =
    (process.env.TSS_SIGNER_PUB_KEY || '').trim() || (fileKeyPair && fileKeyPair.publicKey) || ''
  const signerSecretKey =
    (process.env.TSS_SIGNER_SEC_KEY || '').trim() || (fileKeyPair && fileKeyPair.secretKey) || ''

  if (!signerPublicKey || !signerSecretKey) {
    throw new Error(
      `[auth] TSS signer keyPair is required when ENABLE_SHARDUS_CRYPTO_AUTH=true (set TSS_SIGNER_PUB_KEY/TSS_SIGNER_SEC_KEY or provide ${signerKeyPairFilePath})`
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
const proxyServerHost =
  process.env.LIBERDUS_PROXY_URL || 'https://dev.liberdus.com:3030'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const toShardusAddress = (address) => {
  if (address.length === 64) return address.toLowerCase()
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return address.slice(2).toLowerCase() + '0'.repeat(24)
  }
  return address
}

const loadKeystore = (partyIdx, chainId) => {
  const filePath = path.join(KEYSTORE_DIR, `keystore_party_${partyIdx}_chain_${chainId}.json`)
  if (!fs.existsSync(filePath)) {
    throw new Error(`Keystore not found: ${filePath}`)
  }
  return fs.readFileSync(filePath, 'utf8')
}

const calculateChatId = (from, to) =>
  crypto.hash([from, to].sort((a, b) => a.localeCompare(b)).join(''))

const verifySignedTx = (obj) => {
  const {owner, sig} = obj.sign
  const dataWithoutSign = Object.assign({}, obj)
  dataWithoutSign.sign = undefined
  const message = crypto.hashObj(dataWithoutSign)
  const recoveredAddress = ethers.utils.verifyMessage(message, sig)
  const recoveredShardusAddress = toShardusAddress(recoveredAddress)
  const isValid = recoveredShardusAddress.toLowerCase() === owner.toLowerCase()
  console.log(`  Verification — owner: ${owner}`)
  console.log(`  Verification — recovered: ${recoveredShardusAddress}`)
  return isValid
}

// ─── TSS Signing ─────────────────────────────────────────────────────────────

/**
 * Run one party's share of the TSS signing protocol.
 * Returns the sign_json string on success, or null if the signing slot was full.
 */
async function tssSignParty(partyIdx, keyStore, digest) {
  const operationId = digest.slice(2, 8)
  const delay = Math.max(Math.random() * 500, 100)

  let context
  try {
    context = await gg18.gg18_sign_client_new_context(
      coordinatorUrl,
      t,
      n,
      keyStore,
      digest.slice(2),
      operationId,
    )
  } catch (e) {
    throw new Error(`Party ${partyIdx} failed at new_context: ${e.message || e}`)
  }

  const contextJSON = JSON.parse(context)
  if (contextJSON.party_num_int > t + 1) {
    console.log(
      `  Party ${partyIdx}: slot full (party_num_int=${contextJSON.party_num_int}), skipping`,
    )
    return null
  }
  console.log(
    `  Party ${partyIdx}: assigned party_num_int=${contextJSON.party_num_int}, running rounds...`,
  )

  context = await gg18.gg18_sign_client_round0(context, delay)
  context = await gg18.gg18_sign_client_round1(context, delay)
  context = await gg18.gg18_sign_client_round2(context, delay)
  context = await gg18.gg18_sign_client_round3(context, delay)
  context = await gg18.gg18_sign_client_round4(context, delay)
  context = await gg18.gg18_sign_client_round5(context, delay)
  context = await gg18.gg18_sign_client_round6(context, delay)
  context = await gg18.gg18_sign_client_round7(context, delay)
  context = await gg18.gg18_sign_client_round8(context, delay)
  const signJson = await gg18.gg18_sign_client_round9(context, delay)

  console.log(`  Party ${partyIdx}: signing complete`)
  return signJson
}

// ─── Liberdus Network ────────────────────────────────────────────────────────

async function injectLiberdusTx(txId, signedTx) {
  const body = {tx: stringify(signedTx)}
  const injectUrl = proxyServerHost + '/inject'

  const waitTime = (signedTx.timestamp || 0) - Date.now()
  if (waitTime > 0) {
    console.log(`Waiting ${Math.round(waitTime / 1000)}s for timestamp window...`)
    await sleep(waitTime)
  }

  console.log(`Injecting tx ${txId} → ${injectUrl}`)
  const res = await axios.post(injectUrl, body)
  console.log('Inject response:', JSON.stringify(res.data))
  if (res.status !== 200 || res.data?.result?.success !== true) {
    throw new Error(`Injection rejected: ${JSON.stringify(res.data)}`)
  }
  return {success: true}
}

async function pollForReceipt(txId, maxRetries = 10) {
  const url = proxyServerHost + '/transaction/' + txId
  for (let i = 0; i < maxRetries; i++) {
    await sleep(2000)
    try {
      const res = await axios.get(url)
      if (res.data && res.data.transaction) return res.data.transaction
    } catch (_) {
      // keep polling
    }
    console.log(`  Polling receipt... attempt ${i + 1}/${maxRetries}`)
  }
  return null
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Parse CLI flags ────────────────────────────────────────────────────────

  // Collect named flags (--key value or --key=value) and positional args separately
  const positional = []
  const flags = {}
  const rawArgs = process.argv.slice(2)
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else {
        flags[arg.slice(2)] = rawArgs[++i]
      }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length < 2) {
    console.log('Usage: node scripts/inject-liberdus-tx.js <chainId> <tx-json-file> [options]')
    console.log('')
    console.log('Options:')
    console.log('  --bigint-fields <fields>  Comma-separated tx fields to convert to BigInt')
    console.log('                            (default: "amount")')
    console.log('  --cal-chatid              Compute chatId from from+to and add it to the tx')
    console.log('  --dry-run                 Sign but do not inject')
    console.log('')
    console.log('Examples:')
    console.log('  node scripts/inject-liberdus-tx.js 80002 ./tx.json')
    console.log('  node scripts/inject-liberdus-tx.js 80002 ./tx.json --bigint-fields amount,fee')
    console.log('  node scripts/inject-liberdus-tx.js 80002 ./tx.json --dry-run')
    console.log('')
    console.log('transfer tx.json example:')
    console.log(
      JSON.stringify(
        {
          from: '35576352aabcbce19aece1ffd376f7c49f022706000000000000000000000000',
          to: '<recipient-shardus-address>',
          amount: '1000000000000000000',
          type: 'transfer',
          networkId: chainConfigs.liberdusNetworkId,
          memo: 'optional memo',
        },
        null,
        2,
      ),
    )
    process.exit(1)
  }

  // ── Parse CLI ──────────────────────────────────────────────────────────────

  const chainId = parseInt(positional[0])
  if (isNaN(chainId)) {
    console.error(`Invalid chainId: "${positional[0]}"`)
    process.exit(1)
  }

  const txFilePath = path.resolve(positional[1])
  if (!fs.existsSync(txFilePath)) {
    console.error(`Tx file not found: ${txFilePath}`)
    process.exit(1)
  }

  const bigintFields = (flags['bigint-fields'] || 'amount').split(',').map((f) => f.trim()).filter(Boolean)
  const calChatId = Object.prototype.hasOwnProperty.call(flags, 'cal-chatid')
  const dryRun = Object.prototype.hasOwnProperty.call(flags, 'dry-run')

  // ── Load & prepare tx ─────────────────────────────────────────────────────

  const tx = JSON.parse(fs.readFileSync(txFilePath, 'utf8'))

  if (!tx.from) {
    console.error('Missing required tx field: "from"')
    process.exit(1)
  }
  if (!tx.type) {
    console.error('Missing required tx field: "type"')
    process.exit(1)
  }

  // Normalise addresses to Shardus 64-char format
  tx.from = toShardusAddress(tx.from)
  if (tx.to) tx.to = toShardusAddress(tx.to)

  if (tx.type === 'register') {
    tx.aliasHash = crypto.hash(tx.alias)
  }

  // Convert specified fields to BigInt (JSON cannot represent BigInt natively)
  for (const field of bigintFields) {
    if (tx[field] != null) {
      tx[field] = BigInt(tx[field])
      console.log(`Converted tx.${field} to BigInt`)
    }
  }

  // Compute chatId from from+to if --cal-chatid flag is set
  if (calChatId && tx.to) {
    tx.chatId = calculateChatId(tx.from, tx.to)
    console.log(`Computed chatId: ${tx.chatId}`)
  }

  // Use provided timestamp if present, otherwise stamp with Date.now()
  // Either way it is frozen here so all 5 parties hash the exact same value
  if (!tx.timestamp) tx.timestamp = Date.now() + 5 * 1000
  console.log(`Timestamp: ${tx.timestamp} (${new Date(tx.timestamp).toISOString()})`)

  console.log('\n── Transaction ──────────────────────────────────────────────')
  console.log(JSON.stringify(tx, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2))
  console.log(`\nChainId:     ${chainId}`)
  console.log(`Coordinator: ${coordinatorUrl}`)
  console.log(`Proxy:       ${proxyServerHost}`)

  // ── Compute digest ─────────────────────────────────────────────────────────

  const hashMessage = crypto.hashObj(tx)
  const digest = ethers.utils.hashMessage(hashMessage)
  console.log(`\nHash message: ${hashMessage}`)
  console.log(`Digest:       ${digest}`)

  // ── Load keystores ─────────────────────────────────────────────────────────

  console.log('\n── Loading keystores ────────────────────────────────────────')
  const keystores = []
  for (let i = 1; i <= n; i++) {
    const ks = loadKeystore(i, chainId)
    keystores.push({idx: i, res: ks})
    console.log(`  Party ${i} / chain ${chainId}: OK`)
  }

  // ── TSS Signing (all parties in parallel) ──────────────────────────────────

  console.log(
    `\n── TSS Signing (${n} parties, threshold ${t}, signing slots: ${t + 1}) ──────────────`,
  )

  const settledResults = await Promise.allSettled(
    keystores.map(({idx, res}) => tssSignParty(idx, res, digest)),
  )

  // Collect first successful non-null result
  let signJson = null
  const errors = []
  for (const result of settledResults) {
    if (result.status === 'fulfilled' && result.value !== null) {
      signJson = result.value
      break
    }
    if (result.status === 'rejected') {
      errors.push(result.reason?.message || String(result.reason))
    }
  }

  if (!signJson) {
    console.error('TSS signing failed — no party produced a signature')
    if (errors.length) console.error('Errors:', errors)
    process.exit(1)
  }

  // ── Build signed tx ────────────────────────────────────────────────────────

  const sigParts = JSON.parse(signJson)
  const signature = {
    r: '0x' + sigParts[0],
    s: '0x' + sigParts[1],
    v: Number(sigParts[2]),
  }
  const serializedSignature = ethers.utils.joinSignature(signature)

  const signedTx = {
    ...tx,
    sign: {
      owner: tx.from,
      sig: serializedSignature,
    },
  }

  // ── Verify ─────────────────────────────────────────────────────────────────

  console.log('\n── Verifying signature ──────────────────────────────────────')
  const isValid = verifySignedTx(signedTx)
  console.log(`Signature valid: ${isValid}`)
  if (!isValid) {
    console.error('Signature verification failed — aborting')
    process.exit(1)
  }

  // ── Compute tx ID ──────────────────────────────────────────────────────────

  const txId = crypto.hashObj(signedTx, true)
  console.log(`\nSigned tx ID: ${txId}`)
  console.log(
    'Signed tx:',
    JSON.stringify(signedTx, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  )

  // ── Inject ─────────────────────────────────────────────────────────────────

  if (dryRun) {
    console.log('\n── Dry run — skipping injection ──────────────────────────────')
    return
  }

  console.log('\n── Injecting to Liberdus network ─────────────────────────────')
  try {
    await injectLiberdusTx(txId, signedTx)
  } catch (e) {
    console.error('Injection failed:', e.message)
    process.exit(1)
  }

  // ── Poll for receipt ───────────────────────────────────────────────────────

  console.log('\n── Waiting for receipt ───────────────────────────────────────')
  const receipt = await pollForReceipt(txId)
  if (receipt) {
    if (receipt.success === true) {
      console.log('Transaction confirmed!')
    } else {
      console.log('Transaction failed on-chain:', receipt.reason || 'unknown reason')
    }
    console.log('Receipt:', JSON.stringify(receipt, null, 2))
  } else {
    console.log('No receipt within polling window. Verify manually:')
    console.log(`  ${proxyServerHost}/transaction/${txId}`)
  }
}

main().catch((e) => {
  console.error('Fatal error:', e)
  process.exit(1)
})
