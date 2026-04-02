#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
import * as path from 'node:path'
import * as readlineSync from 'readline-sync'
import * as bnbTss from '../tss-tools/lib/bnbTss'
import {resolveProjectRoot} from '../shared/utils/paths'
import {
  deriveDeterministicKeygenChannelId,
  deriveDeterministicKeygenChannelPassword,
  deriveKeygenCeremonyConfig,
  isValidVaultPassword,
  listLocalExternalIpv4s,
  loadKeygenCeremonyConfig,
  lookupExternalIpv4s,
  resolvePartyIndexFromCandidates,
  resolveKeygenVaultPreparation,
  resolveKeygenCeremonyConfigPath,
  writeDerivedParamsConfig,
} from '../tss-tools/lib/keygenCeremony'

type Options = {
  configPath?: string
  nonce: string
}

function usage(exitCode = 1): never {
  console.error('Usage: node scripts/tss-keygen-ceremony.js --nonce <value> [--config <path>]')
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--config':
        options.configPath = value
        i += 1
        break
      case '--nonce':
        options.nonce = value
        i += 1
        break
      case '-h':
      case '--help':
        usage(0)
        break
      default:
        console.error(`Unknown argument: ${arg}`)
        usage()
    }
  }

  if (!options.nonce || !`${options.nonce}`.trim()) {
    usage()
  }

  return options as Options
}

function promptForVaultPassword(): string {
  while (true) {
    const password = readlineSync.question('Enter BNB_TSS_PASSWORD for this vault: ', {
      hideEchoBack: true,
      mask: '',
    })
    if (isValidVaultPassword(password)) {
      return password
    }
    console.error('BNB_TSS_PASSWORD must be longer than 8 characters')
  }
}

function promptForNewVaultPassword(): string {
  while (true) {
    const password = readlineSync.question('Enter BNB_TSS_PASSWORD for this vault: ', {
      hideEchoBack: true,
      mask: '',
    })
    if (!isValidVaultPassword(password)) {
      console.error('BNB_TSS_PASSWORD must be longer than 8 characters')
      continue
    }
    const confirm = readlineSync.question('Confirm BNB_TSS_PASSWORD: ', {
      hideEchoBack: true,
      mask: '',
    })
    if (password === confirm) {
      return password
    }
    console.error('Passwords do not match, try again')
  }
}

function verifyVaultPassword(signerRoot: string, chainId: number, homePath?: string): string {
  while (true) {
    const password = promptForVaultPassword()
    try {
      bnbTss.describeVault({signerRoot, chainId, password, homePath, useDefaultSlotPath: true})
      return password
    } catch (error) {
      console.error(
        `Vault password did not unlock chain ${chainId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}

function confirmProceed(): void {
  if (!readlineSync.keyInYNStrict('Proceed with keygen using these derived values?')) {
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const signerRoot = resolveProjectRoot()
  const resolvedConfigPath = resolveKeygenCeremonyConfigPath(options.configPath, signerRoot)
  const config = loadKeygenCeremonyConfig(options.configPath, signerRoot)
  const detectedLocalIps = listLocalExternalIpv4s()
  let attemptedExternalLookup = false
  let detectedExternalIps: string[] = []
  let resolution

  try {
    resolution = resolvePartyIndexFromCandidates(config.partyIps, detectedLocalIps)
  } catch (error) {
    const localErrorMessage = error instanceof Error ? error.message : String(error)
    attemptedExternalLookup = true
    detectedExternalIps = await lookupExternalIpv4s()
    if (detectedExternalIps.length === 0) {
      console.warn('External IPv4 lookup did not return any usable IPv4 address.')
    }
    resolution = resolvePartyIndexFromCandidates(config.partyIps, detectedLocalIps, detectedExternalIps)
    if (resolution.source === 'external') {
      console.warn(`Local IPv4 auto-detection did not resolve the party index: ${localErrorMessage}`)
      console.warn('Falling back to external IPv4 lookup results.')
    }
  }

  const committeePosition = resolution.partyIdx
  const derived = deriveKeygenCeremonyConfig(config, committeePosition)
  const {vaultIsNew, vaultHome} = resolveKeygenVaultPreparation(signerRoot, config.chainId)

  const channelId = deriveDeterministicKeygenChannelId(config, options.nonce)
  const channelPassword = deriveDeterministicKeygenChannelPassword(config, options.nonce, channelId)
  const channelExpiryIso = new Date(Number.parseInt(channelId.slice(3), 16) * 1000).toISOString()
  const derivedParams = {
    parties: derived.parties,
    threshold: derived.threshold,
  }
  const paramsPath = path.join(signerRoot, 'params.json')

  console.log('Resolved keygen configuration:')
  console.log(`  config: ${resolvedConfigPath}`)
  console.log(`  params.json target: ${paramsPath}`)
  console.log(`  params.json contents: ${JSON.stringify(derivedParams)}`)
  console.log(`  nonce: ${options.nonce}`)
  console.log(`  chain id: ${config.chainId}`)
  console.log(`  parties: ${derived.parties}`)
  console.log(`  threshold: ${derived.threshold} (requires ${derived.threshold + 1} signers)`)
  console.log(`  committee position: ${derived.committeePosition}`)
  console.log(`  detected local IPv4s: ${detectedLocalIps.length > 0 ? detectedLocalIps.join(', ') : '(none detected)'}`)
  console.log(
    `  detected external IPv4s: ${
      detectedExternalIps.length > 0 ? detectedExternalIps.join(', ') : attemptedExternalLookup ? '(none resolved)' : '(not needed)'
    }`,
  )
  console.log(`  party index source: ${resolution.source}`)
  console.log(`  matched party IP: ${derived.committeePartyIp}`)
  console.log(`  listen port: ${derived.listenPort}`)
  console.log(`  listen addr: ${derived.listenAddr}`)
  console.log(`  peer addrs (${derived.peerAddrs.length}): ${derived.peerAddrs.join(',')}`)
  console.log(`  channel id: ${channelId}`)
  console.log(`  channel id expires at (UTC): ${channelExpiryIso}`)
  console.log(`  vault: ${vaultIsNew ? `will initialize (new) at ${vaultHome}` : `already initialized at ${vaultHome}`}`)

  let password: string
  if (vaultIsNew) {
    password = promptForNewVaultPassword()
    console.log(`Initializing vault for chain ${config.chainId}...`)
    await bnbTss.initParty({
      signerRoot,
      chainId: config.chainId,
      password,
      moniker: bnbTss.getMoniker(derived.committeePosition, config.chainId),
      homePath: vaultHome,
      useDefaultSlotPath: true,
    })
    console.log(`Vault initialized at ${vaultHome}`)
  } else {
    password = verifyVaultPassword(signerRoot, config.chainId, vaultHome)
  }

  confirmProceed()
  writeDerivedParamsConfig(signerRoot, derivedParams)
  console.log(`Wrote params.json at ${paramsPath}`)

  const result = spawnSync(
    'npm',
    [
      'run',
      'tss-keygen',
      '--',
      '--home-path',
      vaultHome,
      '--chain-id',
      String(config.chainId),
      '--parties',
      String(derived.parties),
      '--threshold',
      String(derived.threshold),
      '--peer-addrs',
      derived.peerAddrs.join(','),
      '--no-local-peer-addrs',
    ],
    {
      cwd: signerRoot,
      env: {
        ...process.env,
        BNB_TSS_PASSWORD: password,
        BNB_TSS_CHANNEL_ID: channelId,
        BNB_TSS_CHANNEL_PASSWORD: channelPassword,
      },
      encoding: 'utf8',
      stdio: 'inherit',
    },
  )

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }

  console.log('\nKeygen complete. Set your vault password for this session:')
  console.log('  export BNB_TSS_PASSWORD=your-vault-password')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
