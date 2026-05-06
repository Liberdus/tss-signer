import { ethers } from "ethers";
import axios from "axios";
import * as TransactionDB from "../../shared/storage/transactiondb";
import { chainConfigsRaw, getChainConfigById, isSigningChainConfig, paramsConfigRaw } from "../../shared/config";
import { getCachedPeerObserverUrls } from "../../shared/utils/observerPeers";
import { toEthereumAddress, toShardusAddress } from "../../shared/utils/transformAddress";
import { normalizeTxId } from "../../shared/utils/transformTxId";
import { observerChainRpc } from "../chainRpc";
import { monitorState, saveMonitorState } from "./state";

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
type ObservationVerification = VerificationResult & {
  finalStatus?: TransactionDB.TransactionStatus;
};


function isFinalizedStatus(status: TransactionDB.TransactionStatus): boolean {
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

    let stateChanged = false;

    for (const [chainIdStr, chainConfig] of Object.entries(
      chainConfigsRaw.supportedChains
    )) {
      const chainId = parseInt(chainIdStr);
      const { tssSenderAddress } = chainConfig;
      const bridgeAddress = toShardusAddress(tssSenderAddress);

      const sinceTimestamp: number =
        monitorState.liberdusTimestampByChain[chainIdStr] ?? 0;
      let maxTimestamp = sinceTimestamp;

      let page = 1;
      while (true) {
        const query = `?accountId=${bridgeAddress}&afterTimestamp=${sinceTimestamp}&page=${page}`;
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

            const existingTx = TransactionDB.getTransactionByReceiptId(receiptId);
            if (existingTx) {
              const finalStatus = getFinalizedTxStatus(existingTx.type, status);
              updateBridgeOutReceipt(existingTx, finalStatus, receiptId, txTimestamp, tssSenderAddress);
            } else {
              console.warn(
                `[observer/liberdus] Liberdus bridge delivery observed receiptId=${receiptId} status=${TransactionDB.getStatusLabel(
                  status,
                )} (sourceChain txId not found locally)`,
              )
              const reconciled = await reconcileObservedLiberdusBridgeOut(
                receiptId,
                status,
                txTimestamp,
              );
              if (!reconciled) {
                console.log(
                  `[observer/liberdus] Liberdus bridge delivery observed receiptId=${receiptId} status=${TransactionDB.getStatusLabel(
                    status,
                  )} (sourceChain txId not found locally or from verified peers)`,
                );
              }
            }
          }
        }

        page++;
      }

      if (maxTimestamp > sinceTimestamp) {
        monitorState.liberdusTimestampByChain[chainIdStr] = maxTimestamp;
        stateChanged = true;
      }
    }

    if (stateChanged) {
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
  const peerUrls = getCachedPeerObserverUrls(paramsConfigRaw.parties);
  for (const baseUrl of peerUrls) {
    try {
      const response = await axios.get(`${baseUrl}/transaction`, {
        params: { receiptId },
        timeout: 3_000,
      });
      const txs = response.data?.Ok?.transactions;
      if (Array.isArray(txs) && txs.length > 0) {
        const tx = txs[0] as TransactionDB.Transaction;
        if (!isFinalizedStatus(tx.status)) {
          console.warn(
            `[observer/liberdus] Peer tx found for receiptId=${receiptId} but status=${TransactionDB.getStatusLabel(tx.status)} is not finalized`,
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

async function verifyEvmBridgeOutSourceTx(
  tx: TransactionDB.Transaction,
): Promise<VerificationResult> {
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

async function retryFetch<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function verifyLiberdusTx(
  txId: string,
  expected: { success: boolean; from: string; amount: string },
): Promise<VerificationResult> {
  const proxyServerHost =
    process.env.PROXY_SERVER_HOST || chainConfigsRaw.proxyServerHost || "http://127.0.0.1:3030";

  try {
    const response = await retryFetch(() =>
      axios.get(`${proxyServerHost}/transaction/${txId}`, { timeout: 5_000 }),
    );
    const tx = response.data?.transaction;
    if (!tx) return { ok: false, reason: "missing_liberdus_tx" };
    const success = tx.success;
    if (typeof success !== "boolean") {
      return { ok: false, reason: "missing_liberdus_tx_success" };
    }
    if (success !== expected.success) {
      return {
        ok: false,
        reason: `liberdus_tx_success_mismatch(expected=${expected.success}, found=${success})`,
      };
    }

    const { from, additionalInfo } = tx;
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

function getFinalizedTxStatus(
  txType: TransactionDB.TransactionType,
  observedStatus: TransactionDB.TransactionStatus,
): TransactionDB.TransactionStatus {
  // BRIDGE_IN + observed COMPLETED means a successful refund, stored as REVERTED.
  return txType === TransactionDB.TransactionType.BRIDGE_IN &&
    observedStatus === TransactionDB.TransactionStatus.COMPLETED
    ? TransactionDB.TransactionStatus.REVERTED
    : observedStatus;
}

function isReconcilableTxType(tx: TransactionDB.Transaction): boolean {
  return (
    tx.type === TransactionDB.TransactionType.BRIDGE_OUT ||
    tx.type === TransactionDB.TransactionType.BRIDGE_IN
  );
}

async function verifySourceBridgeTx(
  tx: TransactionDB.Transaction,
  observedStatus: TransactionDB.TransactionStatus,
  receiptTxTimestamp: number,
): Promise<ObservationVerification> {
  if (!isReconcilableTxType(tx)) {
    return { ok: false, reason: `unsupported_tx_type_${tx.type}` };
  }
  const chainConfig = getChainConfigById(chainConfigsRaw, tx.chainId);
  if (!chainConfig || !isSigningChainConfig(chainConfig)) {
    return { ok: false, reason: "missing_chain_tss_sender" };
  }
  if (toEthereumAddress(tx.tssSender ?? "") !== toEthereumAddress(chainConfig.tssSenderAddress)) {
    return { ok: false, reason: "tssSender_mismatch" };
  }
  if (tx.receiptTimestamp !== receiptTxTimestamp) {
    console.warn(
      `[observer/liberdus] receiptTimestamp_mismatch txId=${tx.txId} tx.receiptTimestamp=${tx.receiptTimestamp} receiptTxTimestamp=${receiptTxTimestamp}`,
    );
    return { ok: false, reason: "receiptTimestamp_mismatch" };
  }

  const expectedStatus = getFinalizedTxStatus(tx.type, observedStatus);
  if (tx.status !== expectedStatus) {
    return { ok: false, reason: `observed_status_mismatch(expected=${expectedStatus}, found=${tx.status})` };
  }
  const finalStatus = expectedStatus;

  // If we already have this tx locally, validate against our record — no network call needed.
  const localTx = TransactionDB.getTransactionById(normalizeTxId(tx.txId));
  if (localTx) {
    if (
      localTx.sender !== tx.sender ||
      localTx.value !== tx.value ||
      localTx.type !== tx.type ||
      localTx.chainId !== tx.chainId ||
      localTx.txTimestamp !== tx.txTimestamp
    ) {
      console.warn(
        `[observer/liberdus] Local tx mismatch for txId=${tx.txId}: ` +
        `sender=${localTx.sender}/${tx.sender} value=${localTx.value}/${tx.value} ` +
        `type=${localTx.type}/${tx.type} chainId=${localTx.chainId}/${tx.chainId} ` +
        `txTimestamp=${localTx.txTimestamp}/${tx.txTimestamp}`,
      );
      return { ok: false, reason: "local_tx_mismatch" };
    }
    console.log(`[observer/liberdus] Local tx found for txId=${tx.txId}, skipping network verification`);
    return { ok: true, finalStatus };
  }

  if (tx.type === TransactionDB.TransactionType.BRIDGE_OUT) {
    // Verify the original EVM source tx that triggered this bridge-out delivery.
    const evmVerification = await verifyEvmBridgeOutSourceTx(tx);
    return evmVerification.ok ? { ok: true, finalStatus } : evmVerification;
  }

  // BRIDGE_IN: delivery is a refund — verify the original Liberdus source tx (user → bridge).
  const sourceVerification = await verifyLiberdusTx(tx.txId, {
    success: true,
    from: tx.sender,
    amount: tx.value,
  });
  return sourceVerification.ok ? { ok: true, finalStatus } : sourceVerification;
}


// Validates the observed delivery receipt against an existing local tx, logs any mismatches,
// and applies the status update. Returns true if reconciled (or already settled), false if not found.
function updateBridgeOutReceipt(
  tx: TransactionDB.Transaction,
  finalStatus: TransactionDB.TransactionStatus,
  receiptId: string,
  receiptTimestamp: number,
  tssSenderAddress: string,
  reason: string | null = null,
): boolean {
  const isFinalized = isFinalizedStatus(tx.status);
  const tssSenderMismatch =
    tx.tssSender &&
    toEthereumAddress(tx.tssSender ?? "") !== toEthereumAddress(tssSenderAddress);
  const statusMismatch = tx.status !== finalStatus;
  const receiptIdMismatch = tx.receiptId && tx.receiptId !== receiptId;
  const receiptTimestampMismatch = tx.receiptTimestamp && tx.receiptTimestamp !== receiptTimestamp;

  if (isFinalized) {
    if (statusMismatch) {
      console.warn(
        `[observer/liberdus] Status mismatch for settled ${TransactionDB.TransactionType[tx.type]} txId=${tx.txId}: stored=${TransactionDB.getStatusLabel(tx.status)} expected=${TransactionDB.getStatusLabel(finalStatus)}`,
      );
    }
    if (receiptIdMismatch) {
      console.warn(
        `[observer/liberdus] ReceiptId mismatch for settled ${TransactionDB.TransactionType[tx.type]} txId=${tx.txId}: stored=${tx.receiptId} expected=${receiptId}`,
      );
    }
    if (receiptTimestampMismatch) {
      console.warn(
        `[observer/liberdus] ReceiptTimestamp mismatch for settled ${TransactionDB.TransactionType[tx.type]} txId=${tx.txId}: stored=${tx.receiptTimestamp} expected=${receiptTimestamp}`,
      );
    }
    if (!tssSenderMismatch && !statusMismatch && !receiptIdMismatch && !receiptTimestampMismatch) {
      console.log(
        `[observer/liberdus] Already saved ${TransactionDB.TransactionType[tx.type]} txId=${tx.txId} status=${TransactionDB.getStatusLabel(tx.status)}`,
      );
      return true;
    }
  }

  const result = TransactionDB.updateTransactionStatus(
    tx.txId,
    finalStatus,
    receiptId,
    toEthereumAddress(tssSenderAddress),
    { type: "receiptTimestamp", value: receiptTimestamp },
    reason,
  );
  if (result === "ok") {
    console.log(
      `[observer/liberdus] Updated ${TransactionDB.TransactionType[tx.type]} txId=${tx.txId} receiptId=${receiptId} -> ${TransactionDB.getStatusLabel(finalStatus)}`,
    );
  } else {
    console.warn(
      `[observer/liberdus] Failed to update ${TransactionDB.TransactionType[tx.type]} txId=${tx.txId} -> ${TransactionDB.getStatusLabel(finalStatus)}: ${result}`,
    );
  }
  return result !== "not_found";
}

async function reconcileObservedLiberdusBridgeOut(
  normalizedReceiptId: string,
  status: TransactionDB.TransactionStatus,
  receiptTxTimestamp: number,
): Promise<boolean> {
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

  const verified = await verifySourceBridgeTx(
    peerTx,
    status,
    receiptTxTimestamp,
  );
  if (!verified.ok || verified.finalStatus == null) {
    console.warn(
      `[observer/liberdus] Peer tx found for receiptId=${normalizedReceiptId} but verification failed (${verified.reason})`,
    );
    return false;
  }

  const normalizedTxId = normalizeTxId(peerTx.txId);
  const existingByTxId = TransactionDB.getTransactionById(normalizedTxId);
  if (existingByTxId) {
    const chainConfig = getChainConfigById(chainConfigsRaw, existingByTxId.chainId);
    if (!chainConfig || !isSigningChainConfig(chainConfig)) {
      console.warn(`[observer/liberdus] Cannot update ${TransactionDB.TransactionType[existingByTxId.type]} txId=${existingByTxId.txId}: missing chain tssSenderAddress`);
      return false;
    }
    return updateBridgeOutReceipt(existingByTxId, verified.finalStatus, normalizedReceiptId, receiptTxTimestamp, chainConfig.tssSenderAddress, existingByTxId.reason ?? null);
  }

  const reconciledTx: TransactionDB.Transaction = {
    txId: normalizedTxId,
    sender: peerTx.sender,
    value: peerTx.value,
    type: peerTx.type,
    txTimestamp: peerTx.txTimestamp,
    chainId: peerTx.chainId,
    receiptId: normalizedReceiptId,
    status: verified.finalStatus,
    tssSender: toEthereumAddress(peerTx.tssSender!),
    receiptTimestamp: receiptTxTimestamp,
    reason: peerTx.reason ?? null,
    executionHistory: peerTx.executionHistory ?? "{}",
  };

  TransactionDB.saveTransaction(reconciledTx);
  console.log(
    `[observer/liberdus] Reconciled observed Liberdus receiptId=${normalizedReceiptId} to ${TransactionDB.TransactionType[reconciledTx.type]} txId=${reconciledTx.txId} status=${TransactionDB.getStatusLabel(verified.finalStatus)} from peer (verified=true)`,
  );
  return true;
}
