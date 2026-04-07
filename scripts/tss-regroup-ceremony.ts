#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readlineSync from 'readline-sync'
import * as bnbTss from '../tss-tools/lib/bnbTss'
import {resolveProjectRoot} from '../shared/utils/paths'
import {
  deriveDeterministicRegroupChannelId,
  deriveDeterministicRegroupChannelPassword,
  deriveRegroupCeremonyConfig,
  loadRegroupCeremonyConfig,
  resolveRegroupCeremonyConfigPath,
  resolveRegroupPartyIndex,
} from '../tss-tools/lib/regroupCeremony'
import {isValidVaultPassword} from '../tss-tools/lib/keygenCeremony'

type Options = {
  configPath?: string
  nonce: string
}

function usage(exitCode = 1): never {
  console.error('Usage: node scripts/tss-regroup-ceremony.js --nonce <value> [--config <path>]')
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
    const password = readlineSync.question('Select BNB_TSS_PASSWORD for this vault: ', {
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

function formatVaultBackupTimestamp(date = new Date()): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  const hours = `${date.getHours()}`.padStart(2, '0')
  const minutes = `${date.getMinutes()}`.padStart(2, '0')
  const seconds = `${date.getSeconds()}`.padStart(2, '0')
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`
}

function moveExistingChainHomeForFreshNewMember(vaultHome: string): string {
  if (!fs.existsSync(vaultHome)) {
    throw new Error(`Expected initialized chain home at ${vaultHome}, but it does not exist.`)
  }

  const backupDir = getUniqueChainHomeBackupDir(vaultHome)
  fs.renameSync(vaultHome, backupDir)
  return backupDir
}

function getUniqueChainHomeBackupDir(vaultHome: string): string {
  const parentDir = path.dirname(vaultHome)
  const chainHomeName = path.basename(vaultHome)
  const baseBackupName = `${chainHomeName}-backup-${formatVaultBackupTimestamp()}`
  let backupDir = path.join(parentDir, baseBackupName)
  let suffix = 1
  while (fs.existsSync(backupDir)) {
    backupDir = path.join(parentDir, `${baseBackupName}-${suffix}`)
    suffix += 1
  }
  return backupDir
}

function copyExistingChainHomeForOldMember(vaultHome: string): string {
  if (!fs.existsSync(vaultHome)) {
    throw new Error(`Expected initialized chain home at ${vaultHome}, but it does not exist.`)
  }

  const backupDir = getUniqueChainHomeBackupDir(vaultHome)
  fs.cpSync(vaultHome, backupDir, {recursive: true})
  return backupDir
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
  if (!readlineSync.keyInYNStrict('Proceed with regroup using these derived values?')) {
    process.exit(1)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const signerRoot = resolveProjectRoot()
  const resolvedConfigPath = resolveRegroupCeremonyConfigPath(options.configPath, signerRoot)
  const config = loadRegroupCeremonyConfig(options.configPath, signerRoot)
  const resolution = await resolveRegroupPartyIndex(config)
  const derived = deriveRegroupCeremonyConfig(config, resolution.partyIp)
  const vaultHome = bnbTss.getPartyHome({
    signerRoot,
    chainId: config.chainId,
    useDefaultSlotPath: true,
  })
  let vaultIsNew = false
  try {
    bnbTss.requireInitialized({
      signerRoot,
      chainId: config.chainId,
      useDefaultSlotPath: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.toLowerCase().includes('missing initialized party config')) {
      vaultIsNew = true
    } else {
      throw error
    }
  }
  if (vaultIsNew && derived.isOld) {
    throw new Error(
      `Missing initialized old-member vault at ${vaultHome}. Old participants must already have their previous key share; run regroup only on the original old-member vault.`,
    )
  }
  const channelId = deriveDeterministicRegroupChannelId(config, options.nonce)
  const channelPassword = deriveDeterministicRegroupChannelPassword(config, options.nonce, channelId)
  const channelExpiryIso = new Date(Number.parseInt(channelId.slice(3), 16) * 1000).toISOString()

  console.log('Resolved regroup configuration:')
  console.log(`  config: ${resolvedConfigPath}`)
  console.log(`  nonce: ${options.nonce}`)
  console.log(`  chain id: ${config.chainId}`)
  console.log(`  old parties: ${derived.oldParties}`)
  console.log(`  old threshold: ${derived.oldThreshold} (requires ${derived.oldThreshold + 1} old participants)`)
  console.log(`  new parties: ${derived.newParties}`)
  console.log(`  new threshold: ${derived.newThreshold} (requires ${derived.newThreshold + 1} signers)`)
  console.log(`  committee position: ${derived.committeePosition}`)
  console.log(`  detected local IPv4s: ${resolution.detectedLocalIps.length > 0 ? resolution.detectedLocalIps.join(', ') : '(none detected)'}`)
  console.log(
    `  detected external IPv4s: ${
      resolution.detectedExternalIps.length > 0
        ? resolution.detectedExternalIps.join(', ')
        : resolution.attemptedExternalLookup
          ? '(none resolved)'
          : '(not needed)'
    }`,
  )
  console.log(`  party index source: ${resolution.source}`)
  console.log(`  matched party IP: ${derived.committeePartyIp}`)
  console.log(`  vault moniker: ${bnbTss.getIpBasedMoniker(config.chainId, derived.committeePartyIp)}`)
  console.log(`  wrapper role: ${derived.isOld ? '--is-old' : '--is-new-member'}`)
  console.log(`  new listen addr: ${derived.newListenAddr || '(not used for new-only member)'}`)
  console.log(`  new peer addrs (${derived.newPeerAddrs.length}): ${derived.newPeerAddrs.join(',')}`)
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
      moniker: bnbTss.getIpBasedMoniker(config.chainId, derived.committeePartyIp),
      homePath: vaultHome,
      useDefaultSlotPath: true,
    })
    console.log(`Vault initialized at ${vaultHome}`)
  } else {
    if (derived.isNewMember) {
      const backupDir = moveExistingChainHomeForFreshNewMember(vaultHome)
      console.log(`Moved existing chain home to ${backupDir}`)
      password = promptForNewVaultPassword()
      console.log(`Initializing fresh vault for new-member regroup on chain ${config.chainId}...`)
      await bnbTss.initParty({
        signerRoot,
        chainId: config.chainId,
        password,
        moniker: bnbTss.getIpBasedMoniker(config.chainId, derived.committeePartyIp),
        homePath: vaultHome,
        useDefaultSlotPath: true,
      })
      console.log(`Fresh vault initialized at ${vaultHome}`)
    } else {
      const backupDir = copyExistingChainHomeForOldMember(vaultHome)
      console.log(`Copied existing chain home backup to ${backupDir}`)
      password = verifyVaultPassword(signerRoot, config.chainId, vaultHome)
    }
  }
  confirmProceed()

  const args = [
    'run',
    'tss-regroup',
    '--',
    '--home-path',
    vaultHome,
    '--chain-id',
    String(config.chainId),
    '--threshold',
    String(derived.oldThreshold),
    '--parties',
    String(derived.oldParties),
    '--new-threshold',
    String(derived.newThreshold),
    '--new-parties',
    String(derived.newParties),
    '--new-peer-addrs',
    derived.newPeerAddrs.join(','),
    derived.isOld ? '--is-old' : '--is-new-member',
  ]

  if (derived.newListenAddr) {
    args.push('--new-listen-addr', derived.newListenAddr)
  }

  const result = spawnSync('npm', args, {
    cwd: signerRoot,
    env: {
      ...process.env,
      BNB_TSS_PASSWORD: password,
      BNB_TSS_CHANNEL_ID: channelId,
      BNB_TSS_CHANNEL_PASSWORD: channelPassword,
    },
    encoding: 'utf8',
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    process.exit(result.status || 1)
  }

  console.log('\nRegroup complete. Set your vault password for this session:')
  console.log('  export BNB_TSS_PASSWORD=your-vault-password')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
