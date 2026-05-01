import { ethers } from "ethers";
import axios from "axios";
import * as TransactionDB from "../../shared/storage/transactiondb";
import { chainConfigsRaw, getChainConfigById, paramsConfigRaw } from "../../shared/config";
import { getCachedPeerObserverUrls } from "../../shared/utils/observerPeers";
import { toEthereumAddress, toShardusAddress } from "../../shared/utils/transformAddress";
import { normalizeTxId } from "../../shared/utils/transformTxId";
import { observerChainRpc } from "../chainRpc";
import { monitorState, saveMonitorState } from "./state";

const PEER_TX_LOOKUP_TIMEOUT_MS = 4_000;

const BRIDGE_OUT_EVENT_ABI =
  "event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)";
const BRIDGE_OUT_IFACE = new ethers.utils.Interface([BRIDGE_OUT_EVENT_ABI]);

type ParsedLiberdusBridgeTxBase = {
  sender: string;
  value: ethers.BigNumber;
  status: TransactionDB.TransactionStatus;
  txTimestamp: number;
};

type ParsedLiberdusBridgeTx =
  | (ParsedLiberdusBridgeTxBase & {
      txType: TransactionDB.TransactionType.BRIDGE_IN;
      txId: string;
    })
  | (ParsedLiberdusBridgeTxBase & {
      txType: TransactionDB.TransactionType.BRIDGE_OUT;
      receiptId: string;
    });

type VerificationResult = { ok: boolean; reason?: string };

function isTerminalStatus(status: TransactionDB.TransactionStatus): boolean {
  return (
    status === TransactionDB.TransactionStatus.COMPLETED ||
    status === TransactionDB.TransactionStatus.FAILED ||
    status === TransactionDB.TransactionStatus.REVERTED
  );
}

export async function monitorLiberdusTransactions(): Promise<void> {
  console.log(
    "[observer/liberdus] Running monitorLiberdusTransactions",
    new Date().toISOString()
  );
  try {
    const collectorHost =
      chainConfigsRaw.collectorHost || "http://127.0.0.1:3035";

    let maxTimestamp = monitorState.lastLiberdusTimestamp;

    for (const [chainIdStr, chainConfig] of Object.entries(
      chainConfigsRaw.supportedChains
    )) {
      const chainId = parseInt(chainIdStr);
      const { bridgeAddress } = chainConfig as any;

      let page = 1;
      while (true) {
        const query = `?accountId=${bridgeAddress}&afterTimestamp=${monitorState.lastLiberdusTimestamp}&page=${page}`;
        const url = collectorHost + "/api/transaction" + query;
        const response = await axios.get(url, { timeout: 30_000 });
        const { success, transactions } = response.data;

        if (!success || !transactions || transactions.length === 0) break;

        for (const receipt of transactions) {
          if (receipt.timestamp > maxTimestamp) {
            maxTimestamp = receipt.timestamp;
          }

          const parsed = parseLiberdusBridgeTx(receipt, bridgeAddress);
          if (!parsed) continue;

          if (parsed.txType === TransactionDB.TransactionType.BRIDGE_IN) {
            const { sender, value, txId, status, txTimestamp } = parsed;

            const existing = TransactionDB.getTransactionById(txId);
            if (existing) {
              if (existing.status === TransactionDB.TransactionStatus.COMPLETED) {
                const sourceSender = toEthereumAddress(sender);
                const senderMismatch = existing.sender !== sourceSender;
                const typeMismatch = existing.type !== TransactionDB.TransactionType.BRIDGE_IN;
                const chainMismatch = existing.chainId !== chainId;
                const timestampMismatch = existing.txTimestamp !== txTimestamp;
                if (senderMismatch || typeMismatch || chainMismatch || timestampMismatch) {
                  TransactionDB.updateTransactionSource(existing.txId, {
                    chainId,
                    txTimestamp,
                    ...(senderMismatch && { sender: sourceSender }),
                    ...(typeMismatch && { txType: TransactionDB.TransactionType.BRIDGE_IN }),
                  });
                  console.log(
                    `[observer/liberdus] Updated source for early-saved BRIDGE_IN tx ${existing.txId}`
                  );
                }
              }
              continue;
            }

            const tx: TransactionDB.Transaction = {
              txId,
              sender: toEthereumAddress(sender),
              value: ethers.utils.hexValue(value),
              type: TransactionDB.TransactionType.BRIDGE_IN,
              txTimestamp,
              chainId,
              receiptId: "",
              status,
            };

            TransactionDB.saveTransaction(tx);
            console.log(
              `[observer/liberdus] Saved new BRIDGE_IN tx ${txId}`
            );
          } else {
            const { receiptId, status, txTimestamp } = parsed;
            const reconciled = await reconcileObservedLiberdusBridgeOut(receiptId, status, txTimestamp);
            if (!reconciled) {
              console.log(
                `[observer/liberdus] Liberdus bridge delivery observed receiptId=${receiptId} status=${
                  TransactionDB.getStatusLabel(status)
                } (sourceChain txId not found locally or from verified peers)`
              );
            }
          }
        }

        page++;
      }
    }

    if (maxTimestamp > monitorState.lastLiberdusTimestamp) {
      monitorState.lastLiberdusTimestamp = maxTimestamp;
      saveMonitorState();
    }
  } catch (e) {
    console.error("[observer/liberdus] Error monitoring Liberdus:", e);
  }
}

function parseLiberdusBridgeTx(
  receipt: any,
  bridgeAddress: string,
): ParsedLiberdusBridgeTx | null {
  try {
    const { success, to, from, additionalInfo, type, timestamp, txId: rawTxId } = receipt.data;
    if (type !== "transfer") return null;

    const txId = normalizeTxId(rawTxId);
    const value = ethers.BigNumber.from("0x" + additionalInfo.amount.value);
    const txTimestamp = Number(timestamp);
    if (!Number.isInteger(txTimestamp) || txTimestamp <= 0) return null;

    if (to === bridgeAddress) {
      if (!success) return null; // Only include the successful ones
      return {
        txType: TransactionDB.TransactionType.BRIDGE_IN,
        sender: from,
        value,
        txId,
        txTimestamp,
        status: TransactionDB.TransactionStatus.PENDING
      };
    }

    if (from === bridgeAddress) {
      return {
        txType: TransactionDB.TransactionType.BRIDGE_OUT,
        sender: to,
        value,
        receiptId: txId,
        txTimestamp,
        status: success
          ? TransactionDB.TransactionStatus.COMPLETED
          : TransactionDB.TransactionStatus.FAILED,
      };
    }

    return null;
  } catch (e) {
    console.error("[observer/liberdus] parseLiberdusBridgeTx error:", e);
    return null;
  }
}

async function fetchPeerTransactionByReceiptId(receiptId: string): Promise<TransactionDB.Transaction | null> {
  const selfPartyIdx = Number.parseInt(process.env.PARTY_INDEX ?? "1", 10);
  const peerUrls = getCachedPeerObserverUrls(
    paramsConfigRaw.parties,
    Number.isFinite(selfPartyIdx) ? selfPartyIdx : 1,
  );
  for (const baseUrl of peerUrls) {
    try {
      const response = await axios.get(`${baseUrl}/transaction`, {
        params: { receiptId },
        timeout: PEER_TX_LOOKUP_TIMEOUT_MS,
      });
      const txs = response.data?.Ok?.transactions;
      if (Array.isArray(txs) && txs.length > 0) {
        const tx = txs[0] as TransactionDB.Transaction;
        if (!isTerminalStatus(tx.status)) {
          console.warn(
            `[observer/liberdus] Peer tx found for receiptId=${receiptId} but status=${TransactionDB.getStatusLabel(tx.status)} is not terminal`,
          );
          continue;
        }
        return tx;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function verifyEvmBridgeOutSourceTx(tx: TransactionDB.Transaction): Promise<VerificationResult> {
  const sourceChain = getChainConfigById(chainConfigsRaw, tx.chainId);
  if (!sourceChain?.contractAddress) {
    return { ok: false, reason: "missing_source_chain_contract" };
  }
  if (!observerChainRpc.hasChainHttpProviderConfig(tx.chainId)) {
    return { ok: false, reason: "missing_source_chain_provider" };
  }

  try {
    const receipt = await observerChainRpc.withChainHttpProvider(
      tx.chainId,
      (provider) => provider.getTransactionReceipt(`0x${normalizeTxId(tx.txId)}`),
      { maxRetries: 3 },
    );
    if (!receipt) return { ok: false, reason: "missing_source_chain_receipt" };
    if (receipt.status !== 1) return { ok: false, reason: "source_chain_tx_failed" };

    const contractAddress = sourceChain.contractAddress.toLowerCase();
    for (const log of receipt.logs ?? []) {
      if (log.address.toLowerCase() !== contractAddress) continue;
      try {
        const parsed = BRIDGE_OUT_IFACE.parseLog(log);
        if (parsed.name !== "BridgedOut") continue;

        const targetAddress = toEthereumAddress(parsed.args.targetAddress as string);
        const amount = parsed.args.amount as ethers.BigNumber;
        const chainId = (parsed.args.chainId as ethers.BigNumber).toNumber();
        const timestampMs = (parsed.args.timestamp as ethers.BigNumber).toNumber() * 1000;

        if (targetAddress !== toEthereumAddress(tx.sender)) {
          return { ok: false, reason: "source_targetAddress_mismatch" };
        }
        if (!amount.eq(ethers.BigNumber.from(tx.value))) {
          return { ok: false, reason: "source_amount_mismatch" };
        }
        if (chainId !== tx.chainId) {
          return { ok: false, reason: "source_chainId_mismatch" };
        }
        if (timestampMs !== tx.txTimestamp) {
          return { ok: false, reason: "source_timestamp_mismatch" };
        }

        return { ok: true };
      } catch {
        continue;
      }
    }

    return { ok: false, reason: "missing_source_bridgedOut_event" };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyLiberdusTx(
  txId: string,
  expected: { success: boolean; from: string; amount: string },
): Promise<VerificationResult> {
  const proxyServerHost =
    process.env.PROXY_SERVER_HOST || chainConfigsRaw.proxyServerHost || "http://127.0.0.1:3030";

  try {
    const response = await axios.get(`${proxyServerHost}/transaction/${txId}`, {
      timeout: 10_000,
    });
    const tx = response.data?.transaction;
    const success = tx?.success;
    if (typeof success !== "boolean") {
      return { ok: false, reason: "missing_liberdus_tx_success" };
    }
    if (success !== expected.success) {
      return {
        ok: false,
        reason: `liberdus_tx_success_mismatch(expected=${expected.success}, found=${success})`,
      };
    }

    const { from, additionalInfo } = tx?.data ?? {};
    if (typeof from !== "string" || !from.trim()) {
      return { ok: false, reason: "missing_liberdus_tx_from" };
    }
    if (toShardusAddress(from) !== toShardusAddress(expected.from)) {
      return {
        ok: false,
        reason: `liberdus_tx_from_mismatch(expected=${toShardusAddress(expected.from)}, found=${toShardusAddress(from)})`,
      };
    }

    const amountValue = additionalInfo?.amount?.value;
    if (typeof amountValue !== "string" || !amountValue.trim()) {
      return { ok: false, reason: "missing_liberdus_tx_amount" };
    }
    const rawAmount = amountValue.trim();
    const actualAmount = ethers.BigNumber.from(rawAmount.startsWith("0x") ? rawAmount : `0x${rawAmount}`);
    const expectedAmount = ethers.BigNumber.from(expected.amount);
    if (!actualAmount.eq(expectedAmount)) {
      return {
        ok: false,
        reason: `liberdus_tx_amount_mismatch(expected=${expectedAmount.toString()}, found=${actualAmount.toString()})`,
      };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function terminalStatusFromObservation(
  tx: TransactionDB.Transaction,
  observedStatus: TransactionDB.TransactionStatus,
): TransactionDB.TransactionStatus {
  if (isTerminalStatus(tx.status)) {
    return tx.status;
  }
  if (
    tx.type === TransactionDB.TransactionType.BRIDGE_IN &&
    observedStatus === TransactionDB.TransactionStatus.COMPLETED
  ) {
    return TransactionDB.TransactionStatus.REVERTED;
  }
  return observedStatus;
}

function isSupportedObservedTx(tx: TransactionDB.Transaction): boolean {
  return (
    tx.type === TransactionDB.TransactionType.BRIDGE_OUT ||
    tx.type === TransactionDB.TransactionType.BRIDGE_IN
  );
}

async function verifyObservedLiberdusReceipt(
  tx: TransactionDB.Transaction,
  observedReceiptId: string,
  finalStatus: TransactionDB.TransactionStatus,
): Promise<VerificationResult> {
  const liberdusBridgeAddress = getChainConfigById(chainConfigsRaw, tx.chainId)?.bridgeAddress;
  if (!liberdusBridgeAddress) {
    return { ok: false, reason: "missing_liberdus_bridge_address" };
  }

  const receiptVerification = await verifyLiberdusTx(observedReceiptId, {
    success: finalStatus !== TransactionDB.TransactionStatus.FAILED,
    from: liberdusBridgeAddress,
    amount: tx.value,
  });
  if (!receiptVerification.ok) return receiptVerification;

  if (tx.type === TransactionDB.TransactionType.BRIDGE_OUT) {
    return verifyEvmBridgeOutSourceTx(tx);
  }

  if (
    tx.type === TransactionDB.TransactionType.BRIDGE_IN &&
    (
      finalStatus === TransactionDB.TransactionStatus.REVERTED ||
      finalStatus === TransactionDB.TransactionStatus.FAILED
    )
  ) {
    return verifyLiberdusTx(tx.txId, {
      success: true,
      from: tx.sender,
      amount: tx.value,
    });
  }

  return { ok: false, reason: "unsupported_tx_type_or_status_for_liberdus_receipt" };
}

async function verifyObservedTx(
  tx: TransactionDB.Transaction,
  receiptId: string,
  observedStatus: TransactionDB.TransactionStatus,
  txTimestamp: number,
): Promise<{ ok: boolean; finalStatus?: TransactionDB.TransactionStatus; reason?: string }> {
  if (!isSupportedObservedTx(tx)) {
    return { ok: false, reason: `unsupported_tx_type_${tx.type}` };
  }
  const chainConfig = getChainConfigById(chainConfigsRaw, tx.chainId);
  if (!chainConfig?.tssSenderAddress) {
    return { ok: false, reason: "missing_chain_tss_sender" };
  }
  if (toEthereumAddress(tx.tssSender ?? "") !== toEthereumAddress(chainConfig.tssSenderAddress)) {
    return { ok: false, reason: "tssSender_mismatch" };
  }
  if (tx.nonce !== txTimestamp) {
    console.warn(
      `[observer/liberdus] nonce_mismatch txId=${tx.txId} tx.nonce=${tx.nonce} txTimestamp=${txTimestamp}`,
    );
    return { ok: false, reason: "nonce_mismatch" };
  }

  const finalStatus = terminalStatusFromObservation(tx, observedStatus);
  const verification = await verifyObservedLiberdusReceipt(
    tx,
    receiptId,
    finalStatus,
  );
  return verification.ok
    ? { ok: true, finalStatus }
    : { ok: false, reason: verification.reason };
}

function updateObservedTransactionStatus(
  tx: TransactionDB.Transaction,
  receiptId: string,
  status: TransactionDB.TransactionStatus,
  txTimestamp: number,
): boolean {
  const chainConfig = getChainConfigById(chainConfigsRaw, tx.chainId);
  if (!chainConfig?.tssSenderAddress) {
    console.warn(`[observer/liberdus] Cannot update ${TransactionDB.TransactionType[tx.type]} txId=${tx.txId}: missing chain tssSenderAddress`);
    return false;
  }

  const result = TransactionDB.updateTransactionStatus(
    tx.txId,
    status,
    receiptId,
    toEthereumAddress(chainConfig.tssSenderAddress),
    txTimestamp,
    tx.reason ?? null,
  );
  console.log(
    `[observer/liberdus] Updated ${TransactionDB.TransactionType[tx.type]} txId=${tx.txId} receiptId=${receiptId} -> ${TransactionDB.getStatusLabel(status)} result=${result}`,
  );
  return result !== "not_found";
}

async function reconcileObservedLiberdusBridgeOut(
  receiptId: string,
  status: TransactionDB.TransactionStatus,
  txTimestamp: number,
): Promise<boolean> {
  const normalizedReceiptId = normalizeTxId(receiptId);

  const localTx = TransactionDB.getTransactionByReceiptId(normalizedReceiptId);
  if (localTx) {
    const verified = await verifyObservedTx(localTx, normalizedReceiptId, status, txTimestamp);
    if (!verified.ok || verified.finalStatus == null) {
      console.warn(
        `[observer/liberdus] Local tx found for receiptId=${normalizedReceiptId} but verification failed (${verified.reason})`,
      );
      if (isTerminalStatus(localTx.status)) return false;
      console.warn(
        `[observer/liberdus] Local tx for receiptId=${normalizedReceiptId} is non-terminal; trying verified peer backfill`,
      );
    } else {
      return updateObservedTransactionStatus(localTx, normalizedReceiptId, verified.finalStatus, txTimestamp);
    }
  }

  const peerTx = await fetchPeerTransactionByReceiptId(normalizedReceiptId);
  if (!peerTx) return false;

  let peerReceiptId: string;
  try {
    peerReceiptId = normalizeTxId(peerTx.receiptId);
  } catch {
    console.warn(
      `[observer/liberdus] Peer tx for receiptId=${normalizedReceiptId} has malformed receiptId: ${peerTx.receiptId}`,
    );
    return false;
  }

  if (peerReceiptId !== normalizedReceiptId) {
    console.warn(
      `[observer/liberdus] Peer tx receipt mismatch for observed receiptId=${normalizedReceiptId} peerReceiptId=${peerTx.receiptId}`,
    );
    return false;
  }

  const verified = await verifyObservedTx(peerTx, normalizedReceiptId, status, txTimestamp);
  if (!verified.ok || verified.finalStatus == null) {
    console.warn(
      `[observer/liberdus] Peer tx found for receiptId=${normalizedReceiptId} but verification failed (${verified.reason})`,
    );
    return false;
  }

  const existingByTxId = TransactionDB.getTransactionById(normalizeTxId(peerTx.txId));
  if (existingByTxId) {
    return updateObservedTransactionStatus(existingByTxId, normalizedReceiptId, verified.finalStatus, txTimestamp);
  }

  const reconciledTx: TransactionDB.Transaction = {
    txId: normalizeTxId(peerTx.txId),
    sender: peerTx.sender,
    value: peerTx.value,
    type: peerTx.type,
    txTimestamp: peerTx.txTimestamp,
    chainId: peerTx.chainId,
    receiptId: normalizedReceiptId,
    status: verified.finalStatus,
    tssSender: toEthereumAddress(peerTx.tssSender!),
    nonce: txTimestamp,
    reason: peerTx.reason ?? null,
    executionHistory: peerTx.executionHistory ?? "{}",
  };

  TransactionDB.saveTransaction(reconciledTx);
  console.log(
    `[observer/liberdus] Reconciled observed Liberdus receiptId=${normalizedReceiptId} to ${TransactionDB.TransactionType[reconciledTx.type]} txId=${reconciledTx.txId} status=${TransactionDB.getStatusLabel(verified.finalStatus)} from peer (verified=true)`,
  );
  return true;
}
