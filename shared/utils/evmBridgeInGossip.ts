import { ethers } from "ethers";
import { isNormalizedTxId, normalizeTxId } from "./transformTxId";
import { toEthereumAddress } from "./transformAddress";

const BRIDGE_IN_FUNCTION_ABI =
  "function bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId) public";

const bridgeInIface = new ethers.utils.Interface([BRIDGE_IN_FUNCTION_ABI]);

export interface EVMBridgeInGossipPayload {
  bridgeInTxId: string;
  sourceChainId: number;
  destinationChainId: number;
  txHash: string;
  signedTx: string;
  nonce: number;
  txTimestamp: number;
  senderPartyIdx: number;
}

export function normalizeEVMBridgeInGossipPayload(
  payload: EVMBridgeInGossipPayload,
): EVMBridgeInGossipPayload {
  return {
    ...payload,
    bridgeInTxId: normalizeTxId(payload.bridgeInTxId),
    txHash: normalizeTxId(payload.txHash),
    sourceChainId: Number(payload.sourceChainId),
    destinationChainId: Number(payload.destinationChainId),
    nonce: Number(payload.nonce),
    txTimestamp: Number(payload.txTimestamp),
    senderPartyIdx: Number(payload.senderPartyIdx),
  };
}

export function verifyEVMBridgeInGossipPayload(
  payload: EVMBridgeInGossipPayload,
  expectedTssSender: string,
): { ok: boolean; reason?: string } {
  try {
    const normalized = normalizeEVMBridgeInGossipPayload(payload);

    if (!isNormalizedTxId(normalized.bridgeInTxId)) {
      return { ok: false, reason: "invalid_bridgeInTxId" };
    }
    if (!isNormalizedTxId(normalized.txHash)) {
      return { ok: false, reason: "invalid_txHash" };
    }
    if (!Number.isInteger(normalized.destinationChainId)) {
      return { ok: false, reason: "invalid_destinationChainId" };
    }
    if (!Number.isInteger(normalized.sourceChainId)) {
      return { ok: false, reason: "invalid_sourceChainId" };
    }
    if (!Number.isInteger(normalized.nonce) || normalized.nonce < 0) {
      return { ok: false, reason: "invalid_nonce" };
    }
    if (!Number.isInteger(normalized.txTimestamp) || normalized.txTimestamp <= 0) {
      return { ok: false, reason: "invalid_txTimestamp" };
    }

    const parsed = ethers.utils.parseTransaction(normalized.signedTx);
    const parsedHash = normalizeTxId(parsed.hash ?? "");
    if (parsedHash !== normalized.txHash) {
      return { ok: false, reason: "txHash_mismatch" };
    }
    if (parsed.nonce !== normalized.nonce) {
      return { ok: false, reason: "nonce_mismatch" };
    }
    if (!parsed.from) {
      return { ok: false, reason: "missing_signed_tx_sender" };
    }
    if (toEthereumAddress(parsed.from) !== toEthereumAddress(expectedTssSender)) {
      return { ok: false, reason: "sender_mismatch" };
    }

    const decoded = bridgeInIface.decodeFunctionData("bridgeIn", parsed.data);
    const decodedDestChainId = Number(decoded._chainId);
    const decodedTxId = normalizeTxId(decoded.txId as string);

    if (decodedDestChainId !== normalized.destinationChainId) {
      return { ok: false, reason: "destinationChainId_mismatch" };
    }
    if (decodedTxId !== normalized.bridgeInTxId) {
      return { ok: false, reason: "bridgeInTxId_mismatch" };
    }

    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `invalid_payload:${reason}` };
  }
}
