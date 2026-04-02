export type VerifyDerivePubkeyFormat = 'compressed' | 'ethereum-pubkey' | 'ethereum-address' | 'all'

export type VerifyCliOptions = {
  partyIdx?: number
  chainId: number
  password?: string
  vaultName?: string
  homeRoot?: string
  homePath?: string
  useDefaultSlotPath?: boolean
  format: VerifyDerivePubkeyFormat
}

type KeygenConfigLoader = () => {chainId: number}

type UsageHandler = () => never

function resolveVerifyChainId(
  chainId: number | undefined,
  chainIdExplicit: boolean,
  loadConfig: KeygenConfigLoader,
  onUsage: UsageHandler,
): number {
  if (chainIdExplicit) {
    if (!Number.isInteger(chainId)) onUsage()
    return chainId
  }

  try {
    return loadConfig().chainId
  } catch (error) {
    throw new Error(
      `Missing chain id. Pass --chain-id <id> or provide a valid keygen-config.json (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

export function parseVerifyArgs(
  argv: string[],
  onUsage: UsageHandler,
  loadConfig: KeygenConfigLoader = () => require('./keygenCeremony').loadKeygenCeremonyConfig(),
): VerifyCliOptions {
  const options: Partial<VerifyCliOptions> = {format: 'all'}
  let partyExplicit = false
  let chainIdExplicit = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = argv[i + 1]
    switch (arg) {
      case '--party':
        options.partyIdx = Number.parseInt(value, 10)
        partyExplicit = true
        i += 1
        break
      case '--chain-id':
        options.chainId = Number.parseInt(value, 10)
        chainIdExplicit = true
        i += 1
        break
      case '--password':
        options.password = value
        i += 1
        break
      case '--vault':
        options.vaultName = value
        i += 1
        break
      case '--home-root':
        options.homeRoot = value
        i += 1
        break
      case '--home-path':
        options.homePath = value
        i += 1
        break
      case '--use-default-slot-path':
        options.useDefaultSlotPath = true
        break
      case '--format':
        options.format = value as VerifyDerivePubkeyFormat
        i += 1
        break
      case '-h':
      case '--help':
        onUsage()
        break
      default:
        console.error(`Unknown argument: ${arg}`)
        onUsage()
    }
  }

  options.chainId = resolveVerifyChainId(options.chainId, chainIdExplicit, loadConfig, onUsage)
  if (!partyExplicit) {
    options.useDefaultSlotPath = true
  }
  if (partyExplicit && (!Number.isInteger(options.partyIdx) || options.partyIdx < 1)) onUsage()
  return options as VerifyCliOptions
}
