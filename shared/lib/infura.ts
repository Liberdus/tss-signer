export function infuraHttpRpcUrl(chainId: number, apiKey: string): string | undefined {
  const key = (apiKey || "").trim()
  if (!key) return undefined

  // Infura only supports a subset of networks. Keep this mapping explicit so we
  // can safely fall back to configured rpcUrl for unsupported chains.
  switch (chainId) {
    case 1: // Ethereum mainnet
      return `https://mainnet.infura.io/v3/${key}`
    case 11155111: // Sepolia
      return `https://sepolia.infura.io/v3/${key}`
    case 137: // Polygon mainnet
      return `https://polygon-mainnet.infura.io/v3/${key}`
    case 80002: // Polygon Amoy
      return `https://polygon-amoy.infura.io/v3/${key}`
    case 80001: // Polygon Mumbai (legacy)
      return `https://polygon-mumbai.infura.io/v3/${key}`
    default:
      return undefined
  }
}

