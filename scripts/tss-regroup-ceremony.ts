#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
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
    if (password.length > 8) {
      return password
    }
    console.error('BNB_TSS_PASSWORD must be longer than 8 characters')
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
  const derived = deriveRegroupCeremonyConfig(config, resolution.partyIdx)
  const initialized = bnbTss.requireInitialized({
    signerRoot,
    chainId: config.chainId,
    useDefaultSlotPath: true,
  })
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
  console.log(`  wrapper role: ${derived.isOld ? '--is-old' : '--is-new-member'}`)
  console.log(`  new listen addr: ${derived.newListenAddr || '(not used for new-only member)'}`)
  console.log(`  new peer addrs (${derived.newPeerAddrs.length}): ${derived.newPeerAddrs.join(',')}`)
  console.log(`  channel id: ${channelId}`)
  console.log(`  channel id expires at (UTC): ${channelExpiryIso}`)
  console.log(`  vault: already initialized at ${initialized.home}`)

  const password = verifyVaultPassword(signerRoot, config.chainId, initialized.home)
  confirmProceed()

  const args = [
    'run',
    'tss-regroup',
    '--',
    '--home-path',
    initialized.home,
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
