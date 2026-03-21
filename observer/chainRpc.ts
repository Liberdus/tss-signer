import {chainConfigsRaw, getConfiguredChains} from '../shared/config'
import {initializeChainRpcConfig} from '../shared/chainRpc'

export const observerChainRpc = initializeChainRpcConfig(getConfiguredChains(chainConfigsRaw))
