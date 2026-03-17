import { ethers } from "ethers";
import axios from "axios";
import * as TransactionDB from "../storage/transactiondb";
import { toEthereumAddress } from "../utils/transformAddress";
import { normalizeTxId } from "../utils/transformTxId";
import { chainConfigsRaw } from "../config";
import { monitorState, saveMonitorState } from "./state";

type ParsedBridgeInTx = {
  txType: TransactionDB.TransactionType.BRIDGE_IN;
  sender: string;
  value: ethers.BigNumber;
  txId: string;
  status: TransactionDB.TransactionStatus;
};

type ParsedBridgeOutTx = {
  txType: TransactionDB.TransactionType.BRIDGE_OUT;
  sender: string;
  value: ethers.BigNumber;
  receiptId: string;
  status: TransactionDB.TransactionStatus;
};

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
            const { sender, value, txId, status } = parsed;

            const existing = TransactionDB.getTransactionById(txId);
            if (existing) {
              if (existing.status === TransactionDB.TransactionStatus.COMPLETED) {
                const sourceSender = toEthereumAddress(sender);
                const senderMismatch = existing.sender !== sourceSender;
                const typeMismatch = existing.type !== TransactionDB.TransactionType.BRIDGE_IN;
                const chainMismatch = existing.chainId !== chainId;
                const timestampMismatch = existing.txTimestamp !== receipt.timestamp;
                if (senderMismatch || typeMismatch || chainMismatch || timestampMismatch) {
                  TransactionDB.updateTransactionSource(existing.txId, {
                    chainId,
                    txTimestamp: receipt.timestamp,
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
              txTimestamp: receipt.timestamp,
              chainId,
              receiptId: "",
              status,
            };

            TransactionDB.saveTransaction(tx);
            console.log(
              `[observer/liberdus] Saved BRIDGE_IN tx ${txId} (${
                status === TransactionDB.TransactionStatus.PENDING ? "PENDING" : "FAILED"
              })`
            );
          } else {
            const { receiptId, status } = parsed;
            console.log(
              `[observer/liberdus] BRIDGE_OUT delivery observed receiptId=${receiptId} status=${
                status === TransactionDB.TransactionStatus.COMPLETED ? "COMPLETED" : "FAILED"
              } (sourceChain txId unknown — DB update deferred)`
            );
          }
        }

        page++;
      }
    }

    if (maxTimestamp > monitorState.lastLiberdusTimestamp) {
      monitorState.lastLiberdusTimestamp = maxTimestamp;
      await saveMonitorState();
    }
  } catch (e) {
    console.error("[observer/liberdus] Error monitoring Liberdus:", e);
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
    console.error("[observer/liberdus] parseLiberdusBridgeTx error:", e);
    return null;
  }
}
