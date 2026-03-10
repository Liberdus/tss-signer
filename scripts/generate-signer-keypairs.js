#!/usr/bin/env node
/**
 * generate-signer-keypairs.js
 *
 * Generates Shardus Crypto (Ed25519) signer keypairs for TSS party nodes and saves
 * them to keystores/tss_signer_keypair_party_N.json.
 *
 * Usage:
 *   node scripts/generate-signer-keypairs.js [--parties N] [--party P] [--force]
 *   npm run generate-signer-keypairs [-- --parties N] [-- --party P --force]
 *
 * Options:
 *   --parties N   Number of parties to generate keypairs for (default: 5)
 *   --party P     Generate a keypair for a single party P only (1-indexed)
 *   --force       Overwrite existing keypair files (default: skip existing)
 *
 * After running, copy the printed public keys into:
 *   coordinator/allowed-tss-signers.json  (when enableShardusCryptoAuth = true)
 */

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('@shardus/crypto-utils')

// -------------------------------------------------------------------------
// CLI argument parsing
// -------------------------------------------------------------------------
const args = process.argv.slice(2)

function getArgValue(flag) {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return null
  return args[idx + 1]
}

const force = args.includes('--force')
const partiesArg = getArgValue('--parties')
const partyArg = getArgValue('--party')

const numParties = partiesArg ? parseInt(partiesArg, 10) : 5
if (isNaN(numParties) || numParties < 1) {
  console.error('--parties must be a positive integer')
  process.exit(1)
}

let partyIndices
if (partyArg !== null) {
  const p = parseInt(partyArg, 10)
  if (isNaN(p) || p < 1) {
    console.error('--party must be a positive integer')
    process.exit(1)
  }
  partyIndices = [p]
} else {
  partyIndices = Array.from({ length: numParties }, (_, i) => i + 1)
}

// -------------------------------------------------------------------------
// Main
// -------------------------------------------------------------------------
const keystoresDir = path.resolve(__dirname, '../keystores')
fs.mkdirSync(keystoresDir, { recursive: true })

const generatedPublicKeys = []

for (const partyIdx of partyIndices) {
  const filePath = path.join(keystoresDir, `tss_signer_keypair_party_${partyIdx}.json`)

  if (fs.existsSync(filePath) && !force) {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (existing.publicKey && existing.secretKey) {
      console.log(`[party ${partyIdx}] Keypair already exists — skipping (use --force to overwrite)`)
      console.log(`             publicKey: ${existing.publicKey}`)
      generatedPublicKeys.push(existing.publicKey)
      continue
    }
  }

  const { publicKey, secretKey } = crypto.generateKeypair()
  const keypair = { publicKey, secretKey }

  fs.writeFileSync(filePath, JSON.stringify(keypair, null, 2) + '\n', 'utf8')
  console.log(`[party ${partyIdx}] Keypair written to ${filePath}`)
  console.log(`             publicKey: ${publicKey}`)
  generatedPublicKeys.push(publicKey)
}

// -------------------------------------------------------------------------
// Print allowed-tss-signers.json snippet
// -------------------------------------------------------------------------
console.log('\n--- coordinator/allowed-tss-signers.json ---')
console.log(JSON.stringify({ allowedTSSSigners: generatedPublicKeys }, null, 2))
console.log('')
console.log('Copy the block above into coordinator/allowed-tss-signers.json')
console.log('and set "enableShardusCryptoAuth": true in chain-config.json to enable auth.')
