import axios from "axios";
import { ethers } from "ethers";
import * as TransactionDB from "../../shared/storage/transactiondb";
import { chainConfigsRaw, getChainConfigById, paramsConfigRaw } from "../../shared/config";
import { getCachedPeerObserverUrls } from "../../shared/utils/observerPeers";
import { verifyEVMBridgeInGossipPayload } from "../../shared/utils/evmBridgeInGossip";
import { observerChainRpc } from "../chainRpc";

const PEER_TX_LOOKUP_TIMEOUT_MS = 4_000;

function toSignedEvmTx(rawTx: ethers.providers.TransactionResponse): string | null {
  if (!rawTx.r || !rawTx.s || rawTx.v == null) return null;
  try {
    const unsigned = {
      nonce: rawTx.nonce,
      gasPrice: rawTx.gasPrice ?? undefined,
      gasLimit: rawTx.gasLimit,
      to: rawTx.to ?? undefined,
      value: rawTx.value,
      data: rawTx.data,
      chainId: rawTx.chainId,
      type: rawTx.type ?? undefined,
      maxFeePerGas: rawTx.maxFeePerGas ?? undefined,
      maxPriorityFeePerGas: rawTx.maxPriorityFeePerGas ?? undefined,
      accessList: rawTx.accessList ?? undefined,
    };
    return ethers.utils.serializeTransaction(unsigned, { r: rawTx.r, s: rawTx.s, v: rawTx.v });
  } catch {
    return null;
  }
}

async function fetchPeerTransactionById(txId: string): Promise<TransactionDB.Transaction | null> {
  // Remote: set TSS_SELF_OBSERVER_URL for explicit self exclusion.
  // Local: when unset, peer selection falls back to PARTY_INDEX-based exclusion.
  const selfObserverUrl = process.env.TSS_SELF_OBSERVER_URL;
  const peerUrls = getCachedPeerObserverUrls(paramsConfigRaw.parties, { selfObserverUrl });
  for (const baseUrl of peerUrls) {
    try {
      const response = await axios.get(`${baseUrl}/transaction`, {
        params: { txId },
        timeout: PEER_TX_LOOKUP_TIMEOUT_MS,
      });
      const txs = response.data?.Ok?.transactions;
      if (Array.isArray(txs) && txs.length > 0) {
        return txs[0] as TransactionDB.Transaction;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function validatePeerBridgeInPayload(
  peerTx: TransactionDB.Transaction,
  destinationChainId: number,
): Promise<{ ok: boolean; reason?: string }> {
  if (
    peerTx.type === TransactionDB.TransactionType.BRIDGE_IN ||
    peerTx.type === TransactionDB.TransactionType.BRIDGE_VAULT
  ) {
    if (!peerTx.receiptId || peerTx.nonce == null) {
      return { ok: false, reason: "missing_peer_receipt_or_nonce" };
    }
    const destinationChain = getChainConfigById(chainConfigsRaw, destinationChainId);
    if (!destinationChain?.tssSenderAddress) {
      return { ok: false, reason: "missing_destination_tss_sender" };
    }
    try {
      const onChainTx = await observerChainRpc.withChainHttpProvider(
        destinationChainId,
        (provider) => provider.getTransaction(`0x${peerTx.receiptId}`),
        { maxRetries: 3 },
      );
      if (!onChainTx) return { ok: false, reason: "missing_destination_chain_tx" };
      const signedTx = toSignedEvmTx(onChainTx);
      if (!signedTx) return { ok: false, reason: "failed_to_serialize_signed_tx" };
      return verifyEVMBridgeInGossipPayload(
        {
          txId: peerTx.txId,
          sourceChainId: peerTx.chainId,
          destinationChainId,
          receiptId: peerTx.receiptId,
          signedTx,
          nonce: peerTx.nonce,
          txTimestamp: peerTx.txTimestamp,
        },
        destinationChain.tssSenderAddress,
      );
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  return { ok: false, reason: "unsupported_peer_tx_type_for_bridgeIn_reconcile" };
}

export async function reconcileMissingBridgeInFromPeers(
  txId: string,
  destinationChainId: number,
  receiptId: string,
  chainName: string,
  fallbackTssSender: string,
): Promise<boolean> {
  const peerTx = await fetchPeerTransactionById(txId);
  if (!peerTx) return false;

  const peerValidation = await validatePeerBridgeInPayload(peerTx, destinationChainId);
  if (!peerValidation.ok) {
    console.warn(
      `[observer/bridgeIn] Peer tx found for ${txId} but payload validation failed (${peerValidation.reason})`,
    );
    return false;
  }

  const reconciledTx: TransactionDB.Transaction = {
    txId,
    sender: peerTx.sender,
    value: peerTx.value,
    type: peerTx.type,
    txTimestamp: peerTx.txTimestamp,
    chainId: peerTx.chainId,
    receiptId,
    status: TransactionDB.TransactionStatus.COMPLETED,
    tssSender: peerTx.tssSender ?? fallbackTssSender,
    nonce: peerTx.nonce ?? null,
  };
  TransactionDB.saveTransaction(reconciledTx);
  console.log(
    `[observer/bridgeIn] Reconciled missing tx ${txId} from peer and marked COMPLETED on ${chainName} (payloadVerified=true)`,
  );
  return true;
}
