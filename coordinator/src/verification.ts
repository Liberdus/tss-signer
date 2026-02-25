import axios from "axios";
import * as TransactionDB from "./storage/transactiondb";
import { chainConfigsRaw, chainProviders } from "./config";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Verify that a transaction was successfully executed on-chain.
 *
 * - BRIDGE_OUT: receipt is a Liberdus tx ID → verify via proxy server
 * - BRIDGE_IN / BRIDGE_VAULT: receipt is an EVM tx hash → check receipt status
 *   For BRIDGE_VAULT the receipt lands on the secondary (destination) chain.
 */
export async function verifyTxOnChain(
  type: TransactionDB.TransactionType,
  chainId: number,
  receiptId: string
): Promise<boolean> {
  try {
    if (type === TransactionDB.TransactionType.BRIDGE_OUT) {
      const proxyServerHost =
        chainConfigsRaw.proxyServerHost || "http://127.0.0.1:3030";

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const res = await axios.get(
            `${proxyServerHost}/transaction/${receiptId}`,
            { timeout: 10_000 }
          );
          const tx = res.data?.transaction;
          if (tx?.success === true) return true;
          if (tx?.success === false) return false;
        } catch (e) {
          console.warn(
            `[verifyTxOnChain] BRIDGE_OUT attempt ${attempt + 1} failed:`,
            e
          );
        }
        if (attempt < MAX_ATTEMPTS - 1)
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      return false;
    } else {
      // BRIDGE_VAULT receipt is on the secondary (destination) chain
      const targetChainId =
        type === TransactionDB.TransactionType.BRIDGE_VAULT
          ? chainConfigsRaw.secondaryChainConfig!.chainId
          : chainId;

      const provider = chainProviders.get(targetChainId);
      if (!provider) {
        console.error(
          `[verifyTxOnChain] No provider for chainId ${targetChainId}`
        );
        return false;
      }

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const receipt = await provider.getTransactionReceipt(receiptId);
          if (receipt) return receipt.status === 1;
        } catch (e) {
          console.warn(
            `[verifyTxOnChain] EVM attempt ${attempt + 1} failed:`,
            e
          );
        }
        if (attempt < MAX_ATTEMPTS - 1)
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      return false;
    }
  } catch (e) {
    console.error("[verifyTxOnChain] Unexpected error:", e);
    return false;
  }
}
