import { ethers } from "ethers";
import axios from "axios";
import * as TransactionDB from "../storage/transactiondb";
import { toEthereumAddress } from "../utils/transformAddress";
import { chainConfigsRaw } from "../config";
import { monitorState, saveMonitorState } from "./state";

// ---------------------------------------------------------------------------
// Liberdus monitoring (only active when enableLiberdusNetwork = true)
// ---------------------------------------------------------------------------

function validateCoinToTokenTx(receipt: any): {
  from: string;
  value: ethers.BigNumber;
  txId: string;
  targetChainId: number;
} | null {
  try {
    const { success, to, from, additionalInfo, type, txId } = receipt.data;
    if (!success) return null;
    if (type !== "transfer") return null;

    let targetChainId: number | null = null;
    for (const [chainIdStr, config] of Object.entries(
      chainConfigsRaw.supportedChains
    )) {
      if (to === config.bridgeAddress) {
        targetChainId = parseInt(chainIdStr);
        break;
      }
    }
    if (targetChainId === null) return null;

    const value = ethers.BigNumber.from("0x" + additionalInfo.amount.value);
    return { from, value, txId, targetChainId };
  } catch (e) {
    console.error("[coordinator/liberdus] validateCoinToTokenTx error:", e);
    return null;
  }
}

export async function monitorLiberdusTransactions(): Promise<void> {
  console.log(
    "[coordinator/liberdus] Running monitorLiberdusTransactions",
    new Date().toISOString()
  );
  try {
    const collectorHost =
      chainConfigsRaw.collectorHost || "http://127.0.0.1:3035";
    const bridgeAddresses = Object.values(chainConfigsRaw.supportedChains).map(
      (c) => c.bridgeAddress
    );

    for (const bridgeAddress of bridgeAddresses) {
      const query = `?accountId=${bridgeAddress}&afterTimestamp=${monitorState.lastLiberdusTimestamp}&page=1`;
      const url = collectorHost + "/api/transaction" + query;
      const response = await axios.get(url, { timeout: 30_000 });
      const { success, totalTransactions, transactions } = response.data;

      if (!success || totalTransactions === 0) continue;

      for (let i = 0; i < transactions.length; i++) {
        const receipt = transactions[i];
        const validated = validateCoinToTokenTx(receipt);

        if (!validated) {
          if (i === transactions.length - 1) {
            monitorState.lastLiberdusTimestamp = receipt.timestamp;
            saveMonitorState();
          }
          continue;
        }

        const { from, value, txId, targetChainId } = validated;

        const txIdNorm = txId.toLowerCase();

        // Dedup via DB.  The BridgedIn scanner may have early-saved this tx
        // as COMPLETED using the "0x"-prefixed bytes32 form of the txId, while
        // the Liberdus collector returns plain 64-char hex (no "0x" prefix).
        // Check both formats so we correctly detect the early-save.
        let existing = await TransactionDB.getTransactionById(txIdNorm);
        if (!existing && !txIdNorm.startsWith("0x")) {
          existing = await TransactionDB.getTransactionById("0x" + txIdNorm);
        }

        if (existing) {
          if (existing.status === TransactionDB.TransactionStatus.COMPLETED) {
            // Pre-populated by BridgedIn early-save.  Correct chainId (destination
            // EVM chain), txTimestamp (Liberdus source timestamp), and sender
            // (Liberdus originating address, not the EVM recipient stored earlier).
            await TransactionDB.updateTransactionMetadata(
              existing.txId,
              targetChainId,
              receipt.timestamp,
              toEthereumAddress(from)
            );
            console.log(
              `[coordinator/liberdus] Corrected metadata for early-saved BRIDGE_IN tx ${existing.txId}`
            );
          }
          if (i === transactions.length - 1) {
            monitorState.lastLiberdusTimestamp = receipt.timestamp;
            saveMonitorState();
          }
          continue;
        }

        const tx: TransactionDB.Transaction = {
          txId: txIdNorm,
          sender: toEthereumAddress(from),
          value: ethers.utils.hexValue(value),
          type: TransactionDB.TransactionType.BRIDGE_IN,
          txTimestamp: receipt.timestamp,
          chainId: targetChainId,
          receiptId: "",
          status: TransactionDB.TransactionStatus.PENDING,
        };

        await TransactionDB.saveTransaction(tx);
        console.log(`[coordinator/liberdus] Saved BRIDGE_IN tx ${txIdNorm}`);

        if (i === transactions.length - 1) {
          monitorState.lastLiberdusTimestamp = receipt.timestamp;
          saveMonitorState();
        }
      }
    }
  } catch (e) {
    console.error("[coordinator/liberdus] Error monitoring Liberdus:", e);
  }
}
