import * as path from 'node:path'

export const DEFAULT_RUNTIME_PARTY_IDX = 1

export function resolveRuntimePartyIdx(parsedIdx?: string): number {
  if (parsedIdx == null || `${parsedIdx}`.trim() === '') {
    return DEFAULT_RUNTIME_PARTY_IDX
  }

  const partyIdx = Number.parseInt(parsedIdx, 10)
  if (!Number.isInteger(partyIdx) || partyIdx < 1) {
    throw new Error(`Invalid party index '${parsedIdx}'. Expected a positive integer.`)
  }
  return partyIdx
}

export function deriveObserverUrl(partyIdx: number): string {
  return `http://127.0.0.1:${8100 + partyIdx}`
}

export function deriveTransactionsDbPath(cwd: string, partyIdx: number): string {
  return path.resolve(cwd, 'db', `transactions-${partyIdx}.sqlite`)
}
