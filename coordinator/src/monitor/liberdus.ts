import { ethers } from "ethers";
import axios from "axios";
import * as TransactionDB from "../storage/transactiondb";
import { toEthereumAddress } from "../utils/transformAddress";
import { normalizeTxId } from "../utils/transformTxId";
import { chainConfigsRaw } from "../config";
import { monitorState, saveMonitorState } from "./state";

// ---------------------------------------------------------------------------
// Liberdus monitoring (only active when enableLiberdusNetwork = true)
// ---------------------------------------------------------------------------

type ParsedBridgeInTx = {
  txType: TransactionDB.TransactionType.BRIDGE_IN;
  sender: string; // Liberdus `from` address (user sending coins to bridge)
  value: ethers.BigNumber;
  txId: string;   // Liberdus txId — becomes the DB record's txId
  status: TransactionDB.TransactionStatus; // PENDING (success) or FAILED
};

type ParsedBridgeOutTx = {
  txType: TransactionDB.TransactionType.BRIDGE_OUT;
  sender: string;    // Liberdus `to` address (user receiving coins from bridge)
  value: ethers.BigNumber;
  receiptId: string; // Liberdus txId — delivery receipt for the EVM deposit
  status: TransactionDB.TransactionStatus; // COMPLETED (success) or FAILED
  // NOTE: the source EVM deposit txId is not available in the Liberdus tx.
  // TODO: once a mechanism exists to extract the sourceChain txId from
  //       the Liberdus tx additionalInfo, use it to look up and update the
  //       corresponding BRIDGE_OUT record in the DB.
};

export async function monitorLiberdusTransactions(): Promise<void> {
  console.log(
    "[coordinator/liberdus] Running monitorLiberdusTransactions",
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
            const { sender, value, txId, status } = parsed;

            const existing = await TransactionDB.getTransactionById(txId);
            if (existing) {
              if (existing.status === TransactionDB.TransactionStatus.COMPLETED) {
                // Pre-populated by BridgedIn early-save. Update source-side
                // fields with the authoritative Liberdus timestamp and address.
                const sourceSender = toEthereumAddress(sender);
                const senderMismatch = existing.sender !== sourceSender;
                const typeMismatch = existing.type !== TransactionDB.TransactionType.BRIDGE_IN;
                const chainMismatch = existing.chainId !== chainId;
                const timestampMismatch = existing.txTimestamp !== receipt.timestamp;
                if (senderMismatch || typeMismatch || chainMismatch || timestampMismatch) {
                  await TransactionDB.updateTransactionSource(existing.txId, {
                    chainId,
                    txTimestamp: receipt.timestamp,
                    ...(senderMismatch && { sender: sourceSender }),
                    ...(typeMismatch && { txType: TransactionDB.TransactionType.BRIDGE_IN }),
                  });
                  console.log(
                    `[coordinator/liberdus] Updated source for early-saved BRIDGE_IN tx ${existing.txId}`
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
              txTimestamp: receipt.timestamp,
              chainId,
              receiptId: "",
              status,
            };

            await TransactionDB.saveTransaction(tx);
            console.log(
              `[coordinator/liberdus] Saved BRIDGE_IN tx ${txId} (${status === TransactionDB.TransactionStatus.PENDING ? "PENDING" : "FAILED"})`
            );
          } else {
            // BRIDGE_OUT: bridge delivered Liberdus coins to user.
            // The Liberdus txId is available as a delivery receipt (receiptId),
            // but the originating EVM deposit txId is unknown from this tx alone.
            // TODO: once a mechanism exists to extract the sourceChain txId from
            //       the Liberdus tx additionalInfo, look up the BRIDGE_OUT record
            //       in the DB and mark it COMPLETED/FAILED with this receiptId.
            const { receiptId, status } = parsed;
            console.log(
              `[coordinator/liberdus] BRIDGE_OUT delivery observed receiptId=${receiptId} status=${status === TransactionDB.TransactionStatus.COMPLETED ? "COMPLETED" : "FAILED"} (sourceChain txId unknown — DB update deferred)`
            );
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
    console.error("[coordinator/liberdus] Error monitoring Liberdus:", e);
  }
}

function parseLiberdusBridgeTx(
  receipt: any,
  bridgeAddress: string,
): ParsedBridgeInTx | ParsedBridgeOutTx | null {
  try {
    const { success, to, from, additionalInfo, type, txId: rawTxId } = receipt.data;
    if (type !== "transfer") return null;

    const txId = normalizeTxId(rawTxId);
    const value = ethers.BigNumber.from("0x" + additionalInfo.amount.value);

    if (to === bridgeAddress) {
      // BRIDGE_IN: user sends Liberdus coins to bridge → will receive EVM tokens
      return {
        txType: TransactionDB.TransactionType.BRIDGE_IN,
        sender: from,
        value,
        txId,
        status: success
          ? TransactionDB.TransactionStatus.PENDING
          : TransactionDB.TransactionStatus.FAILED,
      };
    }

    if (from === bridgeAddress) {
      // BRIDGE_OUT: bridge distributes Liberdus coins to user (EVM deposit delivered).
      // The Liberdus txId serves as the delivery receipt.
      // TODO: extract sourceChain txId from additionalInfo once Liberdus carries it.
      return {
        txType: TransactionDB.TransactionType.BRIDGE_OUT,
        sender: to,
        value,
        receiptId: txId,
        status: success
          ? TransactionDB.TransactionStatus.COMPLETED
          : TransactionDB.TransactionStatus.FAILED,
      };
    }

    return null;
  } catch (e) {
    console.error("[coordinator/liberdus] parseLiberdusBridgeTx error:", e);
    return null;
  }
}
