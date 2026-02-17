/**
 * WebSocket provider helper: creates a WebSocketProvider with crash-prevention error handling.
 * Used by tss-party and test-rpc-and-provider so both share the same core logic.
 */
import {ethers} from 'ethers'
import WebSocket from 'ws'

/**
 * Creates a WebSocketProvider with crash-prevention error handling.
 * Attaches an error listener to the underlying socket before passing it to Ethers,
 * preventing unhandled WebSocket errors (e.g., 401 during handshake) from crashing the process.
 */
export function createWebSocketProvider(
  wsUrl: string,
  chainId: number,
  onError: (error: Error) => void
): ethers.providers.WebSocketProvider {
  const displayUrl = wsUrl.replace(/\/[a-f0-9-]+$/i, '/…')
  console.log(`[wsProviderHelper] createWebSocketProvider chainId=${chainId} url=${displayUrl}`)
  const ws = new WebSocket(wsUrl)

  ws.on('error', (error: Error) => {
    onError(error)
  })

  return new ethers.providers.WebSocketProvider(ws as any, chainId)
}
