import path from "path";
import { ethers } from "ethers";
import * as crypto from "@shardus/crypto-utils";
import { toShardusAddress } from "./transformAddress";
import { isNormalizedTxId, normalizeTxId } from "./transformTxId";
import { DEFAULT_SHARDUS_CRYPTO_HASH_KEY } from "../../tss-tools/lib/channelId";

const { stringify, parse } = require(path.join(process.cwd(), "external/stringify-shardus"));
const cryptoInitKey = (process.env.SHARDUS_CRYPTO_HASH_KEY || DEFAULT_SHARDUS_CRYPTO_HASH_KEY).trim();
crypto.init(cryptoInitKey);
crypto.setCustomStringifier(stringify, "shardus_safeStringify");

interface SignedLiberdusTx {
  [key: string]: unknown;
  sign?: {
    owner?: string;
    sig?: string;
  };
}

export interface LiberdusBridgeInGossipPayload {
  txId: string;
  sourceChainId: number;
  receiptId: string;
  liberdusSignedTx: string;
  txTimestamp: number;
}

export function normalizeLiberdusBridgeInGossipPayload(
  payload: LiberdusBridgeInGossipPayload,
): LiberdusBridgeInGossipPayload {
  return {
    txId: normalizeTxId(payload.txId),
    sourceChainId: Number(payload.sourceChainId),
    receiptId: normalizeTxId(payload.receiptId),
    liberdusSignedTx: `${payload.liberdusSignedTx ?? ""}`,
    txTimestamp: Number(payload.txTimestamp),
  };
}

export function verifyLiberdusBridgeInGossipPayload(
  payload: LiberdusBridgeInGossipPayload,
  expectedTssSender: string,
): { ok: boolean; reason?: string } {
  try {
    const normalized = normalizeLiberdusBridgeInGossipPayload(payload);
    if (!isNormalizedTxId(normalized.txId)) {
      return { ok: false, reason: "invalid_txId" };
    }
    if (!isNormalizedTxId(normalized.receiptId)) {
      return { ok: false, reason: "invalid_receiptId" };
    }
    if (!normalized.liberdusSignedTx || typeof normalized.liberdusSignedTx !== "string") {
      return { ok: false, reason: "missing_liberdusSignedTx" };
    }
    if (!Number.isInteger(normalized.sourceChainId)) {
      return { ok: false, reason: "invalid_sourceChainId" };
    }
    if (!Number.isInteger(normalized.txTimestamp) || normalized.txTimestamp <= 0) {
      return { ok: false, reason: "invalid_txTimestamp" };
    }
    const parsedSignedTx = parse(normalized.liberdusSignedTx) as SignedLiberdusTx;
    if (!parsedSignedTx || typeof parsedSignedTx !== "object") {
      return { ok: false, reason: "invalid_liberdusSignedTx_format" };
    }
    if (!parsedSignedTx.sign?.owner || !parsedSignedTx.sign?.sig) {
      return { ok: false, reason: "invalid_liberdusSignedTx_signature_fields" };
    }

    const computedSignedTxId = normalizeTxId(crypto.hashObj(parsedSignedTx, true));
    if (computedSignedTxId !== normalized.receiptId) {
      return { ok: false, reason: "receiptId_mismatch" };
    }

    const unsignedTx = { ...parsedSignedTx };
    delete unsignedTx.sign;
    const message = crypto.hashObj(unsignedTx);
    const recoveredAddress = ethers.utils.verifyMessage(message, parsedSignedTx.sign.sig);
    const recoveredShardusAddress = toShardusAddress(recoveredAddress);
    const ownerShardusAddress = toShardusAddress(parsedSignedTx.sign.owner);
    if (recoveredShardusAddress.toLowerCase() !== ownerShardusAddress.toLowerCase()) {
      return { ok: false, reason: "invalid_liberdusSignedTx_signature" };
    }

    const expectedShardusSender = toShardusAddress(expectedTssSender);
    if (ownerShardusAddress.toLowerCase() !== expectedShardusSender.toLowerCase()) {
      return { ok: false, reason: "sender_mismatch" };
    }

    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `invalid_payload:${reason}` };
  }
}
