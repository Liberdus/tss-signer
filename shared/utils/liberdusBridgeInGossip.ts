import { isNormalizedTxId, normalizeTxId } from "./transformTxId";

export interface LiberdusBridgeInGossipPayload {
  sourceTxId: string;
  sourceChainId: number;
  liberdusTxId: string;
  txTimestamp: number;
  senderPartyIdx: number;
}

export function normalizeLiberdusBridgeInGossipPayload(
  payload: LiberdusBridgeInGossipPayload,
): LiberdusBridgeInGossipPayload {
  return {
    sourceTxId: normalizeTxId(payload.sourceTxId),
    sourceChainId: Number(payload.sourceChainId),
    liberdusTxId: normalizeTxId(payload.liberdusTxId),
    txTimestamp: Number(payload.txTimestamp),
    senderPartyIdx: Number(payload.senderPartyIdx),
  };
}

export function verifyLiberdusBridgeInGossipPayload(
  payload: LiberdusBridgeInGossipPayload,
): { ok: boolean; reason?: string } {
  const normalized = normalizeLiberdusBridgeInGossipPayload(payload);
  if (!isNormalizedTxId(normalized.sourceTxId)) {
    return { ok: false, reason: "invalid_sourceTxId" };
  }
  if (!isNormalizedTxId(normalized.liberdusTxId)) {
    return { ok: false, reason: "invalid_liberdusTxId" };
  }
  if (!Number.isInteger(normalized.sourceChainId)) {
    return { ok: false, reason: "invalid_sourceChainId" };
  }
  if (!Number.isInteger(normalized.txTimestamp) || normalized.txTimestamp <= 0) {
    return { ok: false, reason: "invalid_txTimestamp" };
  }
  if (!Number.isInteger(normalized.senderPartyIdx) || normalized.senderPartyIdx < 1) {
    return { ok: false, reason: "invalid_senderPartyIdx" };
  }
  return { ok: true };
}
