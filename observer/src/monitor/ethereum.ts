import { ethers } from "ethers";
import * as TransactionDB from "../storage/transactiondb";
import { toEthereumAddress } from "../utils/transformAddress";
import { normalizeTxId } from "../utils/transformTxId";
import {
  chainConfigsRaw,
  getChainConfigById,
  invalidateChainHttpProvider,
  monitoredChainIds,
  withChainHttpProvider,
} from "../config";
import { monitorState, saveMonitorState } from "./state";

const BRIDGE_OUT_EVENT_ABI =
  "event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)";

const BRIDGE_IN_EVENT_ABI =
  "event BridgedIn(address indexed to, uint256 amount, uint256 indexed chainId, bytes32 indexed txId, uint256 timestamp)";

const INITIAL_BATCH_SIZE = 2000;
const MIN_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 5000;
const BASE_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRIES_PER_BATCH = 5;
const BLOCK_CONFIRMATION_BUFFER = 120;

const isBridgeOutChainRunning = new Map<number, boolean>();
const bridgeOutBatchSizes = new Map<number, number>();

const isBridgeInChainRunning = new Map<number, boolean>();
const bridgeInBatchSizes = new Map<number, number>();

function getInterBatchDelayMs(nextCursor: number, toBlock: number): number {
  const remaining = toBlock - nextCursor + 1;
  if (remaining > 100_000) return 0;
  if (remaining > 10_000) return 25;
  if (remaining > 1_000) return 100;
  return BASE_DELAY_MS;
}

export async function monitorEthereumBridgeOutQueryFilter(
  targetChainId?: number,
  requireFullSync = false
): Promise<boolean> {
  let allChainsFullyScanned = true;
  for (const chainId of monitoredChainIds) {
    let chainFullyScanned = true;
    if (targetChainId !== undefined && chainId !== targetChainId) continue;

    if (
      !chainConfigsRaw.enableLiberdusNetwork &&
      chainId === chainConfigsRaw.secondaryChainConfig?.chainId
    )
      continue;

    if (isBridgeOutChainRunning.get(chainId)) {
      console.log(`[observer/bridgeOut] Chain ${chainId} scan still active, skipping`);
      continue;
    }
    isBridgeOutChainRunning.set(chainId, true);
    console.log(`[observer/bridgeOut] Starting scan for chain ${chainId}`);

    const chainConfig = getChainConfigById(chainId);
    if (!chainConfig) { isBridgeOutChainRunning.set(chainId, false); continue; }
    const chainName = chainConfig.name;

    const blockMap = chainConfigsRaw.enableLiberdusNetwork
      ? monitorState.blocks
      : monitorState.vault;
    const chainKey = chainId.toString();

    try {
      const newestBlock = await withChainHttpProvider(
        chainId,
        (provider) => provider.getBlockNumber(),
        { maxRetries: 3 }
      );
      const savedBlock = blockMap[chainKey] ?? (chainConfig.deploymentBlock ?? 0);

      const toBlock = newestBlock;
      if (savedBlock >= toBlock) {
        console.log(`[observer/bridgeOut] Already up to date for ${chainName}, skipping`);
        continue;
      }

      const fromBlock = Math.max(
        chainConfig.deploymentBlock ?? 0,
        savedBlock - BLOCK_CONFIRMATION_BUFFER
      );
      console.log(`[observer/bridgeOut] Scanning ${chainName} blocks ${fromBlock}–${toBlock}`);

      const bridgeInterface = new ethers.utils.Interface([BRIDGE_OUT_EVENT_ABI]);
      let batchSize = bridgeOutBatchSizes.get(chainId) ?? INITIAL_BATCH_SIZE;
      let cursor = fromBlock;
      let retryCount = 0;
      let retryDelay = BASE_DELAY_MS;

      while (cursor <= toBlock) {
        const batchEnd = Math.min(cursor + batchSize - 1, toBlock);
        let events: ethers.Event[];

        try {
          events = await withChainHttpProvider(
            chainId,
            async (provider) => {
              const contract = new ethers.Contract(
                chainConfig.contractAddress,
                bridgeInterface,
                provider
              );
              return contract.queryFilter(contract.filters.BridgedOut(), cursor, batchEnd);
            },
            { maxRetries: 3 }
          );
          retryCount = 0;
          retryDelay = BASE_DELAY_MS;
        } catch (error: any) {
          const errorCode = error?.error?.code ?? error?.code;
          const errorMessage = String(error?.message ?? "").toLowerCase();
          const isRateLimit =
            errorCode === -32005 ||
            errorCode === -16412 ||
            errorMessage.includes("limit exceeded") ||
            errorMessage.includes("requested range is over limit");

          if (isRateLimit) {
            if (batchSize > MIN_BATCH_SIZE) {
              batchSize = Math.max(Math.floor(batchSize / 2), MIN_BATCH_SIZE);
              bridgeOutBatchSizes.set(chainId, batchSize);
              console.warn(`[observer/bridgeOut] RPC limit on ${chainName}, reducing batch to ${batchSize}`);
              await new Promise((r) => setTimeout(r, retryDelay));
              continue;
            }
            retryCount++;
            if (retryCount <= MAX_RETRIES_PER_BATCH) {
              retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
              console.warn(
                `[observer/bridgeOut] Rate limited on ${chainName}, retry ${retryCount}/${MAX_RETRIES_PER_BATCH} after ${retryDelay}ms`
              );
              await new Promise((r) => setTimeout(r, retryDelay));
              continue;
            }
            console.error(
              `[observer/bridgeOut] Rate limit retries exhausted for ${chainName} at block ${cursor}, resuming next interval`
            );
            invalidateChainHttpProvider(chainId);
            if (requireFullSync) chainFullyScanned = false;
            break;
          }
          throw error;
        }

        if (events.length > 0) {
          console.log(
            `[observer/bridgeOut] Found ${events.length} BridgedOut events on ${chainName} in blocks ${cursor}–${batchEnd}`
          );
        }

        for (const event of events) {
          if (!event.args) continue;

          const targetAddress = event.args.targetAddress as string;
          const amount = event.args.amount as ethers.BigNumber;
          const parsedChainId = (event.args.chainId as ethers.BigNumber).toNumber();
          const eventTimestamp = (event.args.timestamp as ethers.BigNumber).toNumber();

          if (parsedChainId !== chainId) continue;

          const txId = normalizeTxId(event.transactionHash);
          const txType = !chainConfigsRaw.enableLiberdusNetwork
            ? TransactionDB.TransactionType.BRIDGE_VAULT
            : TransactionDB.TransactionType.BRIDGE_OUT;

          const existing = TransactionDB.getTransactionById(txId);
          if (existing) {
            if (existing.status === TransactionDB.TransactionStatus.COMPLETED) {
              const sourceSender = toEthereumAddress(targetAddress);
              const eventTxTimestamp = eventTimestamp * 1000;
              const senderMismatch = existing.sender !== sourceSender;
              const typeMismatch = existing.type !== txType;
              const chainMismatch = existing.chainId !== chainId;
              const timestampMismatch = existing.txTimestamp !== eventTxTimestamp;
              if (senderMismatch || typeMismatch || chainMismatch || timestampMismatch) {
                TransactionDB.updateTransactionSource(txId, {
                  chainId,
                  txTimestamp: eventTxTimestamp,
                  ...(senderMismatch && { sender: sourceSender }),
                  ...(typeMismatch && { txType }),
                });
                console.log(
                  `[observer/bridgeOut] Updated source for early-saved COMPLETED tx ${txId} on ${chainName}`
                );
              }
            }
            continue;
          }

          const tx: TransactionDB.Transaction = {
            txId,
            sender: toEthereumAddress(targetAddress),
            value: ethers.utils.hexValue(amount),
            type: txType,
            txTimestamp: eventTimestamp * 1000,
            chainId,
            receiptId: "",
            status: TransactionDB.TransactionStatus.PENDING,
          };

          TransactionDB.saveTransaction(tx);
          console.log(
            `[observer/bridgeOut] Saved ${
              txType === TransactionDB.TransactionType.BRIDGE_VAULT ? "BRIDGE_VAULT" : "BRIDGE_OUT"
            } tx ${txId} from ${chainName}`
          );
        }

        cursor = batchEnd + 1;
        blockMap[chainKey] = batchEnd;
        await saveMonitorState();

        if (batchSize < MAX_BATCH_SIZE) {
          batchSize = Math.min(batchSize * 2, MAX_BATCH_SIZE);
          bridgeOutBatchSizes.set(chainId, batchSize);
        }

        if (cursor <= toBlock) {
          const delayMs = getInterBatchDelayMs(cursor, toBlock);
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    } catch (error) {
      if (requireFullSync) chainFullyScanned = false;
      console.error(`[observer/bridgeOut] Error for ${chainName}:`, error);
    } finally {
      isBridgeOutChainRunning.set(chainId, false);
    }
    if (requireFullSync && !chainFullyScanned) allChainsFullyScanned = false;
  }
  return allChainsFullyScanned;
}

export async function monitorEthereumBridgeInQueryFilter(
  targetChainId?: number,
  requireFullSync = false
): Promise<boolean> {
  let allChainsFullyScanned = true;
  for (const chainId of monitoredChainIds) {
    let chainFullyScanned = true;
    if (targetChainId !== undefined && chainId !== targetChainId) continue;

    if (!chainConfigsRaw.enableLiberdusNetwork) {
      if (chainId !== chainConfigsRaw.secondaryChainConfig?.chainId) continue;
    }

    if (isBridgeInChainRunning.get(chainId)) {
      console.log(`[observer/bridgeIn] Chain ${chainId} scan still active, skipping`);
      continue;
    }
    isBridgeInChainRunning.set(chainId, true);
    console.log(`[observer/bridgeIn] Starting scan for chain ${chainId}`);

    const chainConfig = getChainConfigById(chainId);
    if (!chainConfig) { isBridgeInChainRunning.set(chainId, false); continue; }
    const chainName = chainConfig.name;

    try {
      const newestBlock = await withChainHttpProvider(
        chainId,
        (provider) => provider.getBlockNumber(),
        { maxRetries: 3 }
      );
      const savedBlock =
        monitorState.bridgeInBlocks[chainId.toString()] ?? (chainConfig.deploymentBlock ?? 0);

      const toBlock = newestBlock;
      if (savedBlock >= toBlock) {
        console.log(`[observer/bridgeIn] Already up to date for ${chainName}, skipping`);
        continue;
      }

      const fromBlock = Math.max(
        chainConfig.deploymentBlock ?? 0,
        savedBlock - BLOCK_CONFIRMATION_BUFFER
      );
      console.log(`[observer/bridgeIn] Scanning ${chainName} blocks ${fromBlock}–${toBlock}`);

      const bridgeInterface = new ethers.utils.Interface([BRIDGE_IN_EVENT_ABI]);
      let batchSize = bridgeInBatchSizes.get(chainId) ?? INITIAL_BATCH_SIZE;
      let cursor = fromBlock;
      let retryCount = 0;
      let retryDelay = BASE_DELAY_MS;

      while (cursor <= toBlock) {
        const batchEnd = Math.min(cursor + batchSize - 1, toBlock);
        let events: ethers.Event[];

        try {
          events = await withChainHttpProvider(
            chainId,
            async (provider) => {
              const contract = new ethers.Contract(
                chainConfig.contractAddress,
                bridgeInterface,
                provider
              );
              return contract.queryFilter(contract.filters.BridgedIn(), cursor, batchEnd);
            },
            { maxRetries: 3 }
          );
          retryCount = 0;
          retryDelay = BASE_DELAY_MS;
        } catch (error: any) {
          const errorCode = error?.error?.code ?? error?.code;
          const errorMessage = String(error?.message ?? "").toLowerCase();
          const isRateLimit =
            errorCode === -32005 ||
            errorCode === -16412 ||
            errorMessage.includes("limit exceeded") ||
            errorMessage.includes("requested range is over limit");

          if (isRateLimit) {
            if (batchSize > MIN_BATCH_SIZE) {
              batchSize = Math.max(Math.floor(batchSize / 2), MIN_BATCH_SIZE);
              bridgeInBatchSizes.set(chainId, batchSize);
              console.warn(`[observer/bridgeIn] RPC limit on ${chainName}, reducing batch to ${batchSize}`);
              await new Promise((r) => setTimeout(r, retryDelay));
              continue;
            }
            retryCount++;
            if (retryCount <= MAX_RETRIES_PER_BATCH) {
              retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
              console.warn(
                `[observer/bridgeIn] Rate limited on ${chainName}, retry ${retryCount}/${MAX_RETRIES_PER_BATCH} after ${retryDelay}ms`
              );
              await new Promise((r) => setTimeout(r, retryDelay));
              continue;
            }
            console.error(
              `[observer/bridgeIn] Rate limit retries exhausted for ${chainName} at block ${cursor}, resuming next interval`
            );
            invalidateChainHttpProvider(chainId);
            if (requireFullSync) chainFullyScanned = false;
            break;
          }
          throw error;
        }

        if (events.length > 0) {
          console.log(
            `[observer/bridgeIn] Found ${events.length} BridgedIn events on ${chainName} in blocks ${cursor}–${batchEnd}`
          );
        }

        for (const event of events) {
          if (!event.args) {
            console.error(`[observer/bridgeIn] Invalid event ${JSON.stringify(event)}`);
            continue;
          }

          const txId = normalizeTxId(event.args.txId as string);
          const existing = TransactionDB.getTransactionById(txId);

          if (existing) {
            if (existing.status === TransactionDB.TransactionStatus.COMPLETED) {
              console.log(`[observer/bridgeIn] Already completed ${txId} on ${chainName}`);
              continue;
            }
            const result = TransactionDB.updateTransactionStatus(
              txId,
              TransactionDB.TransactionStatus.COMPLETED,
              normalizeTxId(event.transactionHash),
              null
            );
            if (result === "ok") {
              console.log(`[observer/bridgeIn] Marked ${txId} COMPLETED on ${chainName}`);
            }
            continue;
          }

          const isVaultMode = !chainConfigsRaw.enableLiberdusNetwork;
          const txType = isVaultMode
            ? TransactionDB.TransactionType.BRIDGE_VAULT
            : TransactionDB.TransactionType.BRIDGE_IN;
          const eventTimestamp = (event.args.timestamp as ethers.BigNumber).toNumber();

          const earlyTx: TransactionDB.Transaction = {
            txId,
            sender: toEthereumAddress(event.args.to as string),
            value: ethers.utils.hexValue(event.args.amount as ethers.BigNumber),
            type: txType,
            txTimestamp: eventTimestamp * 1000,
            chainId: isVaultMode ? 0 : (event.args.chainId as ethers.BigNumber).toNumber(),
            receiptId: normalizeTxId(event.transactionHash),
            status: TransactionDB.TransactionStatus.COMPLETED,
          };

          TransactionDB.saveTransaction(earlyTx);
          console.log(
            `[observer/bridgeIn] Early-saved COMPLETED ${isVaultMode ? "BRIDGE_VAULT" : "BRIDGE_IN"} tx ${txId} on ${chainName} (metadata pending source event)`
          );
        }

        cursor = batchEnd + 1;
        monitorState.bridgeInBlocks[chainId.toString()] = batchEnd;
        await saveMonitorState();

        if (batchSize < MAX_BATCH_SIZE) {
          batchSize = Math.min(batchSize * 2, MAX_BATCH_SIZE);
          bridgeInBatchSizes.set(chainId, batchSize);
        }

        if (cursor <= toBlock) {
          const delayMs = getInterBatchDelayMs(cursor, toBlock);
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    } catch (error) {
      if (requireFullSync) chainFullyScanned = false;
      console.error(`[observer/bridgeIn] Error for ${chainName}:`, error);
    } finally {
      isBridgeInChainRunning.set(chainId, false);
    }
    if (requireFullSync && !chainFullyScanned) allChainsFullyScanned = false;
  }
  return allChainsFullyScanned;
}
