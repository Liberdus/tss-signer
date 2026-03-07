/**
 * Returns true if the txId is already in normalized form: plain 64-char lowercase hex (no "0x" prefix)
 */
export const isNormalizedTxId = (txId: string): boolean => {
  txId = txId.trim()
  return txId.length === 64 && /^[a-f0-9]{64}$/.test(txId);
};

/**
 * Normalize a transaction ID to a plain 64-char lowercase hex string.
 * Accepts either 64-char hex (no prefix) or "0x"-prefixed 66-char hex.
 * Throws if the input is not one of those two valid lengths.
 */
export const normalizeTxId = (txId: string): string => {
  const lower = txId.trim().toLowerCase()
  const stripped = lower.startsWith("0x") ? lower.slice(2) : lower;
  if (stripped.length !== 64) {
    throw new Error(
      `normalizeTxId: expected 64-char hex (got ${stripped.length} chars): ${txId}`
    )
  }
  return stripped
}
