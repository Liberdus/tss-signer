import axios from "axios";
import { ethers } from "ethers";
import * as TransactionDB from "./storage/transactiondb";
import {
  chainConfigsRaw,
  getChainConfigById,
  hasChainHttpProviderConfig,
  withChainHttpProvider,
} from "./config";
import { normalizeTxId } from "./utils/transformTxId";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const BRIDGE_IN_EVENT_ABI =
  "event BridgedIn(address indexed to, uint256 amount, uint256 indexed chainId, bytes32 indexed txId, uint256 timestamp)";
const bridgeInterface = new ethers.utils.Interface([BRIDGE_IN_EVENT_ABI]);

/**
 * Verify that a terminal transaction result matches its reported outcome.
 *
 * - BRIDGE_OUT:
 *   - COMPLETED  => proxy tx.success must be true
 *   - REVERTED   => proxy tx.success must be false
 * - BRIDGE_IN / BRIDGE_VAULT:
 *   - COMPLETED  => EVM receipt.status must be 1 and BridgedIn event txId must match expectedTxId
 *   - REVERTED   => EVM receipt.status must be 0
 * For BRIDGE_VAULT the receipt lands on the secondary (destination) chain.
 */
export async function verifyTxOnChain(
  type: TransactionDB.TransactionType,
  chainId: number,
  receiptId: string,
  expectedTxId?: string,
  isReverted?: boolean,
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
          if (typeof tx?.success !== "boolean") continue;
          if (isReverted) {
            if (tx.success !== false) {
              console.error(
                `[verifyTxOnChain] Discrepancy: reported REVERTED but Liberdus tx indicates success (receiptId=${receiptId})`
              );
              return false;
            }
            return true;
          }
          if (tx.success !== true) {
            console.error(
              `[verifyTxOnChain] Discrepancy: reported COMPLETED with success but Liberdus tx indicates failure (receiptId=${receiptId})`
            );
            return false;
          }
          return true;
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
      // BRIDGE_VAULT receipt is on the secondary (destination) chain (vault mode only)
      if (
        type === TransactionDB.TransactionType.BRIDGE_VAULT &&
        !chainConfigsRaw.secondaryChainConfig
      ) {
        console.error(
          "[verifyTxOnChain] secondaryChainConfig required for BRIDGE_VAULT verification"
        );
        return false;
      }
      const targetChainId =
        type === TransactionDB.TransactionType.BRIDGE_VAULT
          ? chainConfigsRaw.secondaryChainConfig!.chainId
          : chainId;

      if (!hasChainHttpProviderConfig(targetChainId)) {
        console.error(
          `[verifyTxOnChain] No HTTP provider configured for chainId ${targetChainId}`
        );
        return false;
      }

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          const receipt = await withChainHttpProvider(
            targetChainId,
            (provider) => provider.getTransactionReceipt("0x" + receiptId),
            { maxRetries: 1 }
          );
          if (!receipt) continue;

          if (isReverted) {
            if (receipt.status !== 0) {
              console.error(
                `[verifyTxOnChain] Discrepancy: reported REVERTED but EVM receipt.status=${receipt.status} (receiptId=${receiptId})`
              );
              return false;
            }
            return true;
          }

          if (receipt.status !== 1) {
            console.error(
              `[verifyTxOnChain] Discrepancy: reported COMPLETED with success but EVM receipt.status=${receipt.status} (receiptId=${receiptId})`
            );
            return false;
          }
          if (!expectedTxId) {
            console.error(
              `[verifyTxOnChain] Discrepancy: missing expectedTxId for COMPLETED verification (receiptId=${receiptId})`
            );
            return false;
          }

          const chainConfig = getChainConfigById(targetChainId);
          if (!chainConfig) return false;

          const contractAddress = chainConfig.contractAddress.toLowerCase();
          const normalizedExpectedTxId = normalizeTxId(expectedTxId);

          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== contractAddress) continue;
            try {
              const parsed = bridgeInterface.parseLog(log);
              if (parsed.name !== "BridgedIn") continue;
              const eventTxId = normalizeTxId(parsed.args.txId as string);
              // console.log(
              //   `[verifyTxOnChain] BridgedIn txId=${eventTxId} (expected=${normalizedExpectedTxId}) (receiptId=${receiptId})`
              // );
              if (eventTxId === normalizedExpectedTxId) return true;
              console.error(
                `[verifyTxOnChain] Discrepancy: BridgedIn txId mismatch (expected=${normalizedExpectedTxId}, found=${eventTxId}, receiptId=${receiptId})`
              );
            } catch {
              continue;
            }
          }
          console.error(
            `[verifyTxOnChain] Discrepancy: reported COMPLETED but no matching BridgedIn event txId=${normalizedExpectedTxId} found in receipt ${receiptId}`
          );
          return false;
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
