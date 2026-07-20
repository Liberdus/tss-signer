import {chainConfigsRaw, getConfiguredChains} from '../shared/config'
import {initializeChainRpcConfig} from '../shared/chainRpc'
import {resolveProviderHealthPath} from '../shared/lib/tssHealth'

const rpcProviderMode = chainConfigsRaw.rpcProviderMode ?? 'both'

export const observerChainRpc = initializeChainRpcConfig(getConfiguredChains(chainConfigsRaw), {
  rpcProviderMode,
  providerHealthCheckIntervalHours: chainConfigsRaw.providerHealthCheckIntervalHours,
  providerHealthReportPath: resolveProviderHealthPath(Number.parseInt(process.env.PARTY_INDEX ?? '1', 10)),
})
