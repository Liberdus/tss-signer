export const DEFAULT_STARTUP_RPC_RETRY_DELAY_MS = 5_000

export type StartupRetryOptions = {
  retryDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  logger?: Pick<Console, 'warn'>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function retryStartupRpcOperation<T>(
  label: string,
  operation: () => Promise<T>,
  options: StartupRetryOptions = {},
): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_STARTUP_RPC_RETRY_DELAY_MS
  const sleep = options.sleep ?? defaultSleep
  const logger = options.logger ?? console
  let attempt = 1

  while (true) {
    try {
      return await operation()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn(`[startup-rpc] Failed to ${label} on attempt ${attempt}: ${reason}`)
      logger.warn(`[startup-rpc] Retrying ${label} in ${retryDelayMs}ms`)
      attempt += 1
      await sleep(retryDelayMs)
    }
  }
}
