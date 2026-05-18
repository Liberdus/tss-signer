import {chainConfigsRaw, getConfiguredChains} from '../shared/config'
import {initializeChainRpcConfig} from '../shared/chainRpc'

const rpcProviderMode = chainConfigsRaw.rpcProviderMode ?? 'both'

export const observerChainRpc = initializeChainRpcConfig(getConfiguredChains(chainConfigsRaw), {
  rpcProviderMode,
})
