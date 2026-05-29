import fs from 'fs'
import path from 'path'
import { resolveProjectRoot } from '../utils/paths'

export interface ProviderEntry {
  name: string
  /**
   * One or more values — each can be either a full HTTPS URL (with the API key
   * already embedded) or a bare API key. The code detects which automatically:
   *   - starts with http(s):// → used as the URL directly
   *   - anything else          → treated as an API key; URL is constructed from
   *                              the built-in template for this provider
   *
   * For providers that have account-specific subdomains (e.g. quicknode) only
   * full URLs are accepted — bare keys cannot be used.
   */
  keys: string[]
}

export interface CustomProviderConfig {
  chainId: number
  chainName?: string
  providers: ProviderEntry[]
}

export interface ResolvedProviderUrl {
  name: string
  url: string
}

export interface ProviderLoadResult {
  resolved: ResolvedProviderUrl[]
  skipped: Array<{ name: string; reason: string }>
}

// ---------------------------------------------------------------------------
// Providers that require a full URL — API-key-only construction is not
// supported because their endpoints are account-specific subdomains.
// ---------------------------------------------------------------------------
const URL_ONLY_PROVIDERS = new Set(['quicknode'])

// ---------------------------------------------------------------------------
// Known URL templates — keyed as `${providerName}:${chainId}`.
// ---------------------------------------------------------------------------
const URL_TEMPLATES: Record<string, string> = {
  // Polygon (chainId 137)
  'alchemy:137':    'https://polygon-mainnet.g.alchemy.com/v2/{key}',
  'infura:137':     'https://polygon-mainnet.infura.io/v3/{key}',
  'drpc:137':       'https://lb.drpc.live/polygon/{key}',
  'getblock:137':   'https://go.getblock.us/{key}',
  'moralis:137':    'https://site1.moralis-nodes.com/polygon/{key}',
  'ankr:137':       'https://rpc.ankr.com/polygon/{key}',
  'rpcfast:137':    'https://polygon-mainnet.rpcfast.com?api_key={key}',
  'onfinality:137': 'https://polygon.api.onfinality.io/rpc?apikey={key}',
  'tenderly:137':   'https://polygon.gateway.tenderly.co/{key}',

  // BSC (chainId 56)
  'alchemy:56':     'https://bnb-mainnet.g.alchemy.com/v2/{key}',
  'infura:56':      'https://bsc-mainnet.infura.io/v3/{key}',
  'drpc:56':        'https://lb.drpc.live/bsc/{key}',
  'getblock:56':    'https://shared.us-east-1.getblock.io/{key}',
  'moralis:56':     'https://site1.moralis-nodes.com/bsc/{key}',
  'ankr:56':        'https://rpc.ankr.com/bsc/{key}',
  'rpcfast:56':     'https://bsc-mainnet.rpcfast.com?api_key={key}',
  'onfinality:56':  'https://bnb.api.onfinality.io/rpc?apikey={key}',
}

function buildUrlFromTemplate(name: string, chainId: number, apiKey: string): string | undefined {
  const templateKey = `${name.toLowerCase()}:${chainId}`
  const template = URL_TEMPLATES[templateKey]
  if (!template) return undefined
  return template.replace('{key}', apiKey.trim())
}

/**
 * Reads and parses a provider config JSON file.
 */
export function loadCustomProviderFile(filePath: string): CustomProviderConfig {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[customProviders] Provider config not found: ${filePath}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (e) {
    throw new Error(`[customProviders] Failed to parse ${filePath}: ${(e as Error).message}`)
  }
  const config = raw as CustomProviderConfig
  if (typeof config.chainId !== 'number') {
    throw new Error(`[customProviders] ${filePath}: "chainId" must be a number`)
  }
  if (!Array.isArray(config.providers)) {
    throw new Error(`[customProviders] ${filePath}: "providers" must be an array`)
  }
  return config
}

/**
 * Iterates each provider entry and resolves it to a final HTTPS URL.
 *
 * Per entry:
 *   - key starts with http(s):// → used as the URL directly
 *   - key is a bare string       → URL is constructed from the built-in template
 *   - key is empty               → skipped with a reason
 *
 * Providers in URL_ONLY_PROVIDERS (e.g. quicknode) must have a full URL.
 *
 * Returns both the resolved URLs and the list of skipped entries with reasons.
 */
export function buildUrlsFromProviderConfig(config: CustomProviderConfig): ProviderLoadResult {
  const resolved: ResolvedProviderUrl[] = []
  const skipped: Array<{ name: string; reason: string }> = []

  for (const entry of config.providers) {
    const name = (entry.name || '').trim()
    if (!name) {
      skipped.push({ name: '(unnamed)', reason: 'missing name field' })
      continue
    }

    const keys = (entry.keys ?? []).map((k) => (k || '').trim()).filter(Boolean)
    if (keys.length === 0) {
      console.warn(
        `[customProviders] Provider "${name}" has no keys — skipping. Add at least one URL or API key to enable it.`,
      )
      skipped.push({ name, reason: 'keys is empty' })
      continue
    }

    const isUrlOnly = URL_ONLY_PROVIDERS.has(name.toLowerCase())

    for (const key of keys) {
      const isUrl = key.startsWith('https://') || key.startsWith('http://')

      if (isUrlOnly) {
        if (!isUrl) {
          skipped.push({
            name,
            reason: `"${name}" requires a full https:// URL — a bare API key cannot be used for this provider`,
          })
          continue
        }
        resolved.push({ name, url: key })
        continue
      }

      if (isUrl) {
        resolved.push({ name, url: key })
        continue
      }

      // Bare API key — construct URL from template.
      const constructed = buildUrlFromTemplate(name, config.chainId, key)
      if (!constructed) {
        skipped.push({
          name,
          reason: `no URL template known for "${name}" on chainId ${config.chainId} — provide a full https:// URL instead`,
        })
        continue
      }
      resolved.push({ name, url: constructed })
    }
  }

  return { resolved, skipped }
}

/**
 * Loads and resolves provider URLs for a given chainId.
 *
 * Looks for:
 *   - chainId 137 → providers-polygon.json
 *   - chainId  56 → providers-bsc.json
 *
 * Throws if the file is missing or if no URLs can be resolved.
 */
export function loadCustomProviderUrls(
  chainId: number,
  fromDir?: string,
): ProviderLoadResult {
  const fileNameByChain: Record<number, string> = {
    137: 'providers-polygon.json',
    56:  'providers-bsc.json',
  }

  const fileName = fileNameByChain[chainId]
  if (!fileName) {
    throw new Error(`[customProviders] No provider config file defined for chainId ${chainId}`)
  }

  const root = resolveProjectRoot(fromDir ?? __dirname)
  const filePath = path.join(root, fileName)
  const config = loadCustomProviderFile(filePath)

  if (config.chainId !== chainId) {
    throw new Error(
      `[customProviders] ${fileName} declares chainId ${config.chainId} but expected ${chainId}`,
    )
  }

  const result = buildUrlsFromProviderConfig(config)

  if (result.resolved.length === 0) {
    throw new Error(
      `[customProviders] No valid URLs resolved from ${fileName}. ` +
      `Add at least one entry with a valid key (URL or API key).`,
    )
  }

  return result
}
