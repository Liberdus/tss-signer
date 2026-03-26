import {chainConfigsRaw, getConfiguredChains} from '../shared/config'
import {initializeChainRpcConfig} from '../shared/chainRpc'

function parseInfuraKeysFromEnv(): string[] {
  // Prefer JSON array to avoid escaping issues, fall back to comma-separated.
  const rawJson = process.env.INFURA_API_KEYS_JSON
  if (rawJson && rawJson.trim()) {
    try {
      const parsed = JSON.parse(rawJson)
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((s) => s.trim()).filter(Boolean)
      }
    } catch {
      // ignore
    }
  }
  const raw = process.env.INFURA_API_KEYS
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const useInfura =
  (chainConfigsRaw as any).useInfuraRpcProviders === true ||
  process.env.USE_INFURA_RPC_PROVIDERS === 'true'

export const observerChainRpc = initializeChainRpcConfig(getConfiguredChains(chainConfigsRaw), {
  useInfuraRpcProviders: useInfura,
  infuraApiKeys: parseInfuraKeysFromEnv(),
})
