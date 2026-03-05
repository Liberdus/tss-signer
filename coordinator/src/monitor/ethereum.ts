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

// ---------------------------------------------------------------------------
// Adaptive-batch queryFilter constants
// ---------------------------------------------------------------------------

const INITIAL_BATCH_SIZE = 2000;
const MIN_BATCH_SIZE = 100;
const MAX_BATCH_SIZE = 5000;
const BASE_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRIES_PER_BATCH = 5;

// Number of blocks to stay behind the chain tip to avoid scanning blocks whose
// events may not yet be fully indexed by the RPC node.
const BLOCK_CONFIRMATION_BUFFER = 120;

// Per-chain running flags — allow chains to be scanned independently.
// A notify-triggered scan for chain A does not block a concurrent scheduler
// scan from processing chain B.
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

// ---------------------------------------------------------------------------
// BridgedOut event monitoring — queryFilter only (no WebSocket)
//
// targetChainId (optional):
//   If provided, only the specified chain is scanned. Used by the
//   /notify-bridgeout endpoint to target the chain that received the event.
//   If omitted (scheduled interval), all chains are scanned sequentially.
// ---------------------------------------------------------------------------

export async function monitorEthereumBridgeOutQueryFilter(
  targetChainId?: number,
  requireFullSync = false
): Promise<boolean> {
  let allChainsFullyScanned = true;
  for (const chainId of monitoredChainIds) {
      let chainFullyScanned = true;
      // If called with a specific chainId, skip all other chains.
      if (targetChainId !== undefined && chainId !== targetChainId) continue;

      // In vault mode only vaultChain emits events — skip secondaryChainConfig
      if (
        !chainConfigsRaw.enableLiberdusNetwork &&
        chainId === chainConfigsRaw.secondaryChainConfig?.chainId
      )
        continue;

      // Per-chain lock: skip this chain if a scan is already in progress for it.
      if (isBridgeOutChainRunning.get(chainId)) {
        console.log(
          `[coordinator/bridgeOut] Chain ${chainId} scan still active, skipping`
        );
        continue;
      }
      isBridgeOutChainRunning.set(chainId, true);
      console.log(
        `[coordinator/bridgeOut] Starting scan for chain ${chainId}`
      );

      const chainConfig = getChainConfigById(chainId);
      if (!chainConfig) { isBridgeOutChainRunning.set(chainId, false); continue; }
      const chainName = chainConfig.name;

      // Use separate block maps so vault and Liberdus mode contracts on the
      // same chainId track their cursors independently.
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
        const savedBlock =
          blockMap[chainKey] ??
          (chainConfig.deploymentBlock ?? 0);

        const toBlock = newestBlock - BLOCK_CONFIRMATION_BUFFER;
        if (savedBlock >= toBlock) {
          console.log(
            `[coordinator/bridgeOut] Already up to date for ${chainName}, skipping`
          );
          continue;
        }

        const fromBlock = Math.max(
          chainConfig.deploymentBlock ?? 0,
          savedBlock - BLOCK_CONFIRMATION_BUFFER // small overlap for redundancy
        );
        console.log(
          `[coordinator/bridgeOut] Scanning ${chainName} blocks ${fromBlock}–${toBlock}`
        );

        const bridgeInterface = new ethers.utils.Interface([
          BRIDGE_OUT_EVENT_ABI,
        ]);

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
                return contract.queryFilter(
                  contract.filters.BridgedOut(),
                  cursor,
                  batchEnd
                );
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
                console.warn(
                  `[coordinator/bridgeOut] RPC limit on ${chainName}, reducing batch to ${batchSize}`
                );
                await new Promise((r) => setTimeout(r, retryDelay));
                continue;
              }
              retryCount++;
              if (retryCount <= MAX_RETRIES_PER_BATCH) {
                retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
                console.warn(
                  `[coordinator/bridgeOut] Rate limited on ${chainName}, retry ${retryCount}/${MAX_RETRIES_PER_BATCH} after ${retryDelay}ms`
                );
                await new Promise((r) => setTimeout(r, retryDelay));
                continue;
              }
              console.error(
                `[coordinator/bridgeOut] Rate limit retries exhausted for ${chainName} at block ${cursor}, resuming next interval`
              );
              invalidateChainHttpProvider(chainId);
              if (requireFullSync) {
                chainFullyScanned = false;
              }
              break;
            }
            throw error;
          }

          if (events.length > 0) {
            console.log(
              `[coordinator/bridgeOut] Found ${events.length} BridgedOut events on ${chainName} in blocks ${cursor}–${batchEnd}`
            );
          }

          for (const event of events) {
            if (!event.args) continue;

            const targetAddress = event.args.targetAddress as string;
            const amount = event.args.amount as ethers.BigNumber;
            const parsedChainId = (
              event.args.chainId as ethers.BigNumber
            ).toNumber();
            const eventTimestamp = (
              event.args.timestamp as ethers.BigNumber
            ).toNumber();

            // Replay protection: only process events whose chainId matches the source chain
            if (parsedChainId !== chainId) continue;

            const txId = normalizeTxId(event.transactionHash);

            const txType = !chainConfigsRaw.enableLiberdusNetwork
              ? TransactionDB.TransactionType.BRIDGE_VAULT
              : TransactionDB.TransactionType.BRIDGE_OUT;

            // Dedup via DB
            const existing = await TransactionDB.getTransactionById(txId);
            if (existing) {
              if (existing.status === TransactionDB.TransactionStatus.COMPLETED) {
                // Pre-populated by BridgedIn early-save before BridgedOut was observed.
                // Update source-side fields with the authoritative chainId and
                // txTimestamp from the BridgedOut event.
                const sourceSender = toEthereumAddress(targetAddress);
                const eventTxTimestamp = eventTimestamp * 1000;
                const senderMismatch = existing.sender !== sourceSender;
                const typeMismatch = existing.type !== txType;
                const chainMismatch = existing.chainId !== chainId;
                const timestampMismatch = existing.txTimestamp !== eventTxTimestamp;
                if (senderMismatch || typeMismatch || chainMismatch || timestampMismatch) {
                  await TransactionDB.updateTransactionSource(txId, {
                    chainId,
                    txTimestamp: eventTxTimestamp,
                    ...(senderMismatch && { sender: sourceSender }),
                    ...(typeMismatch && { txType }),
                  });
                  console.log(
                    `[coordinator/bridgeOut] Updated source for early-saved COMPLETED tx ${txId} on ${chainName}`
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

            await TransactionDB.saveTransaction(tx);
            console.log(
              `[coordinator/bridgeOut] Saved ${
                txType === TransactionDB.TransactionType.BRIDGE_VAULT
                  ? "BRIDGE_VAULT"
                  : "BRIDGE_OUT"
              } tx ${txId} from ${chainName}`
            );
          }

          // Advance cursor and persist block state
          cursor = batchEnd + 1;
          blockMap[chainKey] = batchEnd;
          saveMonitorState();

          // Gradually recover batch size after a successful batch
          if (batchSize < MAX_BATCH_SIZE) {
            batchSize = Math.min(batchSize * 2, MAX_BATCH_SIZE);
            bridgeOutBatchSizes.set(chainId, batchSize);
          }

          if (cursor <= toBlock) {
            const delayMs = getInterBatchDelayMs(cursor, toBlock);
            if (delayMs > 0) {
              await new Promise((r) => setTimeout(r, delayMs));
            }
          }
        }
      } catch (error) {
        if (requireFullSync) {
          chainFullyScanned = false;
        }
        console.error(
          `[coordinator/bridgeOut] Error for ${chainName}:`,
          error
        );
      } finally {
        // Always release the per-chain lock, even if the scan threw or used
        // `continue` to skip to the next chain early.
        isBridgeOutChainRunning.set(chainId, false);
      }
      if (requireFullSync && !chainFullyScanned) {
        allChainsFullyScanned = false;
      }
  }
  return allChainsFullyScanned;
}

// ---------------------------------------------------------------------------
// BridgedIn event monitoring
//
// Scans for BridgedIn events and marks the corresponding transactions as
// COMPLETED.  In vault mode only the secondary chain emits BridgedIn; in
// Liberdus mode all supported chains do.
//
// Early-save: if the originating source event (BridgedOut / Liberdus tx) has
// not been observed yet, a COMPLETED record is written with best-effort data.
// The BridgedOut scanner / Liberdus monitor will correct chainId, txTimestamp
// (and sender for BRIDGE_IN) when they later encounter the source event.
//
// txId normalisation: the on-chain bytes32 txId comes as "0x"+64 hex chars;
// Liberdus txIds are plain 64-char hex (no 0x prefix). All are normalised to
// plain 64-char lowercase hex via normalizeTxId before any DB lookup or save.
// ---------------------------------------------------------------------------

export async function monitorEthereumBridgeInQueryFilter(
  targetChainId?: number,
  requireFullSync = false
): Promise<boolean> {
  let allChainsFullyScanned = true;
  for (const chainId of monitoredChainIds) {
    let chainFullyScanned = true;
    if (targetChainId !== undefined && chainId !== targetChainId) continue;

    // Vault mode: BridgedIn only on secondary chain.
    // Liberdus mode: BridgedIn on all supported chains.
    if (!chainConfigsRaw.enableLiberdusNetwork) {
      if (chainId !== chainConfigsRaw.secondaryChainConfig?.chainId) continue;
    }

    if (isBridgeInChainRunning.get(chainId)) {
      console.log(
        `[coordinator/bridgeIn] Chain ${chainId} scan still active, skipping`
      );
      continue;
    }
    isBridgeInChainRunning.set(chainId, true);
    console.log(`[coordinator/bridgeIn] Starting scan for chain ${chainId}`);

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
        monitorState.bridgeInBlocks[chainId.toString()] ??
        (chainConfig.deploymentBlock ?? 0);

      const toBlock = newestBlock - BLOCK_CONFIRMATION_BUFFER;
      if (savedBlock >= toBlock) {
        console.log(
          `[coordinator/bridgeIn] Already up to date for ${chainName}, skipping`
        );
        continue;
      }

      const fromBlock = Math.max(
        chainConfig.deploymentBlock ?? 0,
        savedBlock - BLOCK_CONFIRMATION_BUFFER
      );
      console.log(
        `[coordinator/bridgeIn] Scanning ${chainName} blocks ${fromBlock}–${toBlock}`
      );

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
              return contract.queryFilter(
                contract.filters.BridgedIn(),
                cursor,
                batchEnd
              );
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
              console.warn(
                `[coordinator/bridgeIn] RPC limit on ${chainName}, reducing batch to ${batchSize}`
              );
              await new Promise((r) => setTimeout(r, retryDelay));
              continue;
            }
            retryCount++;
            if (retryCount <= MAX_RETRIES_PER_BATCH) {
              retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
              console.warn(
                `[coordinator/bridgeIn] Rate limited on ${chainName}, retry ${retryCount}/${MAX_RETRIES_PER_BATCH} after ${retryDelay}ms`
              );
              await new Promise((r) => setTimeout(r, retryDelay));
              continue;
            }
            console.error(
              `[coordinator/bridgeIn] Rate limit retries exhausted for ${chainName} at block ${cursor}, resuming next interval`
            );
            invalidateChainHttpProvider(chainId);
            if (requireFullSync) {
              chainFullyScanned = false;
            }
            break;
          }
          throw error;
        }

        if (events.length > 0) {
          console.log(
            `[coordinator/bridgeIn] Found ${events.length} BridgedIn events on ${chainName} in blocks ${cursor}–${batchEnd}`
          );
        }

        for (const event of events) {
          if (!event.args) {
            console.error(
              `[coordinator/bridgeIn] Invalid event ${JSON.stringify(event)}`
            );
            continue;
          }

          // bytes32 txId from event is always "0x"+64 hex chars; normalise to
          // plain 64-char lowercase hex to match the uniform storage format.
          const txId = normalizeTxId(event.args.txId as string);

          const existing = await TransactionDB.getTransactionById(txId);

          if (existing) {
            if (existing.status === TransactionDB.TransactionStatus.COMPLETED) {
              console.log(
                `[coordinator/bridgeIn] Already completed ${txId} on ${chainName}`
              )
              continue; // Already completed — nothing to do
            }
            // PENDING or PROCESSING: mark completed with this BridgedIn tx as receipt
            await TransactionDB.updateTransactionStatus(
              txId,
              TransactionDB.TransactionStatus.COMPLETED,
              normalizeTxId(event.transactionHash),
              null
            );
            console.log(
              `[coordinator/bridgeIn] Marked ${txId} COMPLETED on ${chainName}`
            );
            continue;
          }

          // No matching source record yet — early-save as COMPLETED.
          // chainId and txTimestamp will be corrected when the source event
          // (BridgedOut on vault chain, or Liberdus tx) is later observed.
          const isVaultMode = !chainConfigsRaw.enableLiberdusNetwork;

          const txType = isVaultMode
            ? TransactionDB.TransactionType.BRIDGE_VAULT
            : TransactionDB.TransactionType.BRIDGE_IN;

          const eventTimestamp = (
            event.args.timestamp as ethers.BigNumber
          ).toNumber();

          const earlyTx: TransactionDB.Transaction = {
            txId,
            // For BRIDGE_IN: `to` is the EVM recipient, not the Liberdus sender.
            // The Liberdus monitor will correct this via updateTransactionSource.
            sender: toEthereumAddress(event.args.to as string),
            value: ethers.utils.hexValue(event.args.amount as ethers.BigNumber),
            type: txType,
            // txTimestamp is the BridgedIn execution time; source timestamp is
            // unknown until the originating event is observed.
            txTimestamp: eventTimestamp * 1000,
            // BRIDGE_VAULT: vault source chainId is unknown here; placeholder 0
            //   will be corrected by BridgedOut scanner.
            // BRIDGE_IN: _chainId from event = destination EVM chain = correct
            //   (matches what Liberdus monitor stores as targetChainId).
            chainId: isVaultMode
              ? 0
              : (event.args.chainId as ethers.BigNumber).toNumber(),
            receiptId: normalizeTxId(event.transactionHash),
            status: TransactionDB.TransactionStatus.COMPLETED,
          };

          await TransactionDB.saveTransaction(earlyTx);
          console.log(
            `[coordinator/bridgeIn] Early-saved COMPLETED ${isVaultMode ? "BRIDGE_VAULT" : "BRIDGE_IN"} tx ${txId} on ${chainName} (metadata pending source event)`
          );
        }

        // Advance cursor and persist block state
        cursor = batchEnd + 1;
        monitorState.bridgeInBlocks[chainId.toString()] = batchEnd;
        saveMonitorState();

        // Gradually recover batch size after a successful batch
        if (batchSize < MAX_BATCH_SIZE) {
          batchSize = Math.min(batchSize * 2, MAX_BATCH_SIZE);
          bridgeInBatchSizes.set(chainId, batchSize);
        }

        if (cursor <= toBlock) {
          const delayMs = getInterBatchDelayMs(cursor, toBlock);
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
      }
    } catch (error) {
      if (requireFullSync) {
        chainFullyScanned = false;
      }
      console.error(`[coordinator/bridgeIn] Error for ${chainName}:`, error);
    } finally {
      isBridgeInChainRunning.set(chainId, false);
    }
    if (requireFullSync && !chainFullyScanned) {
      allChainsFullyScanned = false;
    }
  }
  return allChainsFullyScanned;
}
