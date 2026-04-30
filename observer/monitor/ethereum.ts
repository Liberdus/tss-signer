import { ethers } from "ethers";
import * as TransactionDB from "../../shared/storage/transactiondb";
import { chainConfigsRaw, getChainConfigById } from "../../shared/config";
import { toEthereumAddress } from "../../shared/utils/transformAddress";
import { normalizeTxId } from "../../shared/utils/transformTxId";
import { observerChainRpc } from "../chainRpc";
import { monitorState, saveMonitorState } from "./state";

const BRIDGE_OUT_EVENT_ABI =
  "event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)";

const BRIDGE_IN_EVENT_ABI =
  "event BridgedIn(address indexed to, uint256 amount, uint256 indexed chainId, bytes32 indexed txId, uint256 timestamp)";

const BRIDGE_IN_FUNCTION_ABI =
  "function bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId) public";

const BRIDGE_OUT_IFACE = new ethers.utils.Interface([BRIDGE_OUT_EVENT_ABI]);
const BRIDGE_IN_IFACE = new ethers.utils.Interface([BRIDGE_IN_EVENT_ABI]);
const BRIDGE_IN_CALL_IFACE = new ethers.utils.Interface([BRIDGE_IN_FUNCTION_ABI]);

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

const isFailedTxScanRunning = new Map<number, boolean>();
// Max blocks fetched per cycle — keeps each run bounded when catching up after a long gap
const MAX_FAILED_TX_SCAN_BLOCKS_PER_CYCLE = 500;

function getBridgeInSuccessStatus(
  txType: TransactionDB.TransactionType | undefined,
  sourceChainId: number | undefined,
  bridgeInChainId: number,
): TransactionDB.TransactionStatus {
  return txType === TransactionDB.TransactionType.BRIDGE_OUT && sourceChainId === bridgeInChainId
    ? TransactionDB.TransactionStatus.REVERTED
    : TransactionDB.TransactionStatus.COMPLETED;
}

function sameReceiptId(a: string, b: string): boolean {
  if (!a || !b) return false;
  try {
    return normalizeTxId(a) === normalizeTxId(b);
  } catch {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
}

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
  for (const chainId of observerChainRpc.chainIds) {
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

    const chainConfig = getChainConfigById(chainConfigsRaw, chainId);
    if (!chainConfig) { isBridgeOutChainRunning.set(chainId, false); continue; }
    const chainName = chainConfig.name;

    const blockMap = chainConfigsRaw.enableLiberdusNetwork
      ? monitorState.blocks
      : monitorState.vault;
    const chainKey = chainId.toString();

    try {
      const newestBlock = await observerChainRpc.withChainHttpProvider(
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

      let batchSize = bridgeOutBatchSizes.get(chainId) ?? INITIAL_BATCH_SIZE;
      let cursor = fromBlock;
      let retryCount = 0;
      let retryDelay = BASE_DELAY_MS;

      while (cursor <= toBlock) {
        const batchEnd = Math.min(cursor + batchSize - 1, toBlock);
        let events: ethers.Event[];

        try {
          events = await observerChainRpc.withChainHttpProvider(
            chainId,
            async (provider) => {
              const contract = new ethers.Contract(
                chainConfig.contractAddress,
                BRIDGE_OUT_IFACE,
                provider
              );
              return contract.queryFilter(contract.filters.BridgedOut(), cursor, batchEnd);
            },
            { maxRetries: 3, timeoutMs: 30_000 }
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
            observerChainRpc.invalidateChainHttpProvider(chainId);
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
            if (
              existing.status === TransactionDB.TransactionStatus.COMPLETED ||
              existing.status === TransactionDB.TransactionStatus.REVERTED
            ) {
              const sourceSender = toEthereumAddress(targetAddress);
              const eventTxTimestamp = eventTimestamp * 1000;
              const senderMismatch = existing.sender !== sourceSender;
              const typeMismatch = existing.type !== txType;
              const chainMismatch = existing.chainId !== chainId;
              const timestampMismatch = existing.txTimestamp !== eventTxTimestamp;
              const status = txType === TransactionDB.TransactionType.BRIDGE_OUT && existing.type !== TransactionDB.TransactionType.BRIDGE_OUT
                ? TransactionDB.TransactionStatus.REVERTED
                : existing.status;
              const statusMismatch = existing.status !== status;
              if (senderMismatch || typeMismatch || chainMismatch || timestampMismatch || statusMismatch) {
                TransactionDB.updateTransactionSource(txId, {
                  chainId,
                  txTimestamp: eventTxTimestamp,
                  ...(senderMismatch && { sender: sourceSender }),
                  ...(typeMismatch && { txType }),
                  ...(statusMismatch && { status }),
                });
                console.log(
                  `[observer/bridgeOut] Updated source for early-saved ${TransactionDB.getStatusLabel(status)} tx ${txId} on ${chainName}`
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
        saveMonitorState();

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
  for (const chainId of observerChainRpc.chainIds) {
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

    const chainConfig = getChainConfigById(chainConfigsRaw, chainId);
    if (!chainConfig) { isBridgeInChainRunning.set(chainId, false); continue; }
    const chainName = chainConfig.name;

    try {
      const newestBlock = await observerChainRpc.withChainHttpProvider(
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

      let batchSize = bridgeInBatchSizes.get(chainId) ?? INITIAL_BATCH_SIZE;
      let cursor = fromBlock;
      let retryCount = 0;
      let retryDelay = BASE_DELAY_MS;

      while (cursor <= toBlock) {
        const batchEnd = Math.min(cursor + batchSize - 1, toBlock);
        let events: ethers.Event[];

        try {
          events = await observerChainRpc.withChainHttpProvider(
            chainId,
            async (provider) => {
              const contract = new ethers.Contract(
                chainConfig.contractAddress,
                BRIDGE_IN_IFACE,
                provider
              );
              return contract.queryFilter(contract.filters.BridgedIn(), cursor, batchEnd);
            },
            { maxRetries: 3, timeoutMs: 30_000 }
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
            observerChainRpc.invalidateChainHttpProvider(chainId);
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
            const successStatus = getBridgeInSuccessStatus(existing.type, existing.chainId, chainId);
            const successStatusLabel = TransactionDB.getStatusLabel(successStatus);
            if (existing.status === successStatus) {
              if (existing.receiptId && !sameReceiptId(existing.receiptId, event.transactionHash)) {
                console.error(`[observer/bridgeIn] Duplicate BridgedIn event for ${txId} on ${chainName}, but different receipt ${event.transactionHash} vs ${existing.receiptId}`);
              }
              console.log(`[observer/bridgeIn] Already ${successStatusLabel} ${txId} on ${chainName}`);
              continue;
            }
            let txTssSender: string | null = null;
            let txNonce: number | null = null;
            // Sync nonce + tssSender from the on-chain tx if they differ
            try {
              const onChainTx = await observerChainRpc.withChainHttpProvider(
                chainId,
                (provider) => provider.getTransaction(event.transactionHash),
                { maxRetries: 3 },
              );
              txNonce = onChainTx?.nonce ?? null;
              txTssSender = onChainTx?.from?.toLowerCase() ?? null;
              if (txNonce == null || txTssSender == null) {
                console.warn(`[observer/bridgeIn] Failed to extract nonce for ${txId} on ${chainName}`, txNonce, txTssSender);
              }
            } catch {
              console.warn(`[observer/bridgeIn] Failed to sync nonce for ${txId} on ${chainName}`);
            }
            const result = TransactionDB.updateTransactionStatus(
              txId,
              successStatus,
              normalizeTxId(event.transactionHash),
              txTssSender as string,  // null falls back to current.tssSender in DB
              txNonce as number,       // null falls back to current.nonce in DB
              null,
            );
            if (result === "ok") {
              console.log(`[observer/bridgeIn] Marked ${txId} ${successStatusLabel} on ${chainName}`);
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
            tssSender: chainConfig.tssSenderAddress.toLowerCase() || null,
          };

          // Attempt to extract nonce + tssSender from the on-chain transaction
          try {
            const onChainTx = await observerChainRpc.withChainHttpProvider(
              chainId,
              (provider) => provider.getTransaction(event.transactionHash),
              { maxRetries: 3 },
            );
            if (onChainTx?.nonce != null) {
              earlyTx.nonce = onChainTx.nonce;
            }
            if (onChainTx?.from) {
              earlyTx.tssSender = onChainTx.from.toLowerCase();
            }
          } catch {
            console.warn(`[observer/bridgeIn] Failed to sync nonce for ${txId} on ${chainName}`);
          }

          TransactionDB.saveTransaction(earlyTx);
          console.log(
            `[observer/bridgeIn] Early-saved COMPLETED ${isVaultMode ? "BRIDGE_VAULT" : "BRIDGE_IN"} tx ${txId} on ${chainName} (metadata pending source event)`
          );
        }

        cursor = batchEnd + 1;
        monitorState.bridgeInBlocks[chainId.toString()] = batchEnd;
        saveMonitorState();

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
  // Run failed tx detection immediately after BridgeIn scan — always paired together
  await monitorFailedBridgeIns(targetChainId);
  return allChainsFullyScanned;
}

// ---------------------------------------------------------------------------
// monitorFailedBridgeIns — detects failed (on-chain execution failure) bridgeIn calls from tssSender.
//
// Standard eth_getLogs cannot capture failed transactions (no events emitted).
// Instead this function:
//   1. Compares the on-chain nonce for tssSender against the last known nonce.
//   2. When a gap is detected, scans blocks in the gap range with
//      getBlockWithTransactions, filtering for txs FROM tssSender TO the bridge
//      contract.
//   3. For any tx with receipt.status === 0, decodes the txId from calldata and
//      marks the DB row as FAILED so the TSS party's pre-sign guard can exit
//      cleanly on the next retry.
//
// The block cursor (failedTxScanBlocks) is advanced per block so a crash mid-scan
// resumes where it left off rather than re-scanning from the start.
// ---------------------------------------------------------------------------

export async function monitorFailedBridgeIns(targetChainId?: number): Promise<boolean> {
  let allChainsSeeded = true;
  for (const chainId of observerChainRpc.chainIds) {
    if (targetChainId !== undefined && chainId !== targetChainId) continue;

    const chainConfig = getChainConfigById(chainConfigsRaw, chainId);
    if (!chainConfig?.tssSenderAddress) continue;

    // Mirror the BridgeIn scan: vault mode only scans the secondary chain
    if (!chainConfigsRaw.enableLiberdusNetwork) {
      if (chainId !== chainConfigsRaw.secondaryChainConfig?.chainId) continue;
    }

    if (isFailedTxScanRunning.get(chainId)) {
      console.log(`[observer/failedtx] Chain ${chainId} scan still active, skipping`);
      continue;
    }
    isFailedTxScanRunning.set(chainId, true);

    const tssSender = chainConfig.tssSenderAddress.toLowerCase();
    const bridgeContract = chainConfig.contractAddress.toLowerCase();
    const chainKey = chainId.toString();
    const senderKey = `${chainId}:${tssSender}`;

    try {
      const [currentBlock, chainNonce] = await Promise.all([
        observerChainRpc.withChainHttpProvider(chainId, (p) => p.getBlockNumber(), { maxRetries: 3 }),
        observerChainRpc.withChainHttpProvider(chainId, (p) => p.getTransactionCount(tssSender), { maxRetries: 3 }),
      ]);

      // On first run, seed the nonce baseline without scanning history
      if (monitorState.failedTxNonces[senderKey] == null) {
        monitorState.failedTxNonces[senderKey] = chainNonce;
        monitorState.failedTxScanBlocks[chainKey] = currentBlock;
        saveMonitorState();
        continue;
      }

      const lastKnownNonce = monitorState.failedTxNonces[senderKey];

      if (chainNonce <= lastKnownNonce) {
        // No new txs from tssSender — advance block cursor, keeping a confirmation
        // buffer so RPC inconsistency between getBlockNumber and getTransactionCount
        // (e.g. load-balanced nodes at different chain tips) doesn't cause the cursor
        // to skip past a block that contains a failed tx.
        monitorState.failedTxScanBlocks[chainKey] = Math.max(
          monitorState.failedTxScanBlocks[chainKey] ?? 0,
          currentBlock - BLOCK_CONFIRMATION_BUFFER,
        );
        saveMonitorState();
        continue;
      }

      const gapCount = chainNonce - lastKnownNonce;
      const fromBlock = monitorState.failedTxScanBlocks[chainKey] ?? Math.max(chainConfig.deploymentBlock ?? 0, currentBlock - BLOCK_CONFIRMATION_BUFFER);
      const toBlock = Math.min(currentBlock, fromBlock + MAX_FAILED_TX_SCAN_BLOCKS_PER_CYCLE);

      console.log(
        `[observer/failedtx] Observed sender nonce advance on chain ${chainId} (${chainConfig.name}): ` +
        `${lastKnownNonce} → ${chainNonce} (${gapCount} tx(s)); checking DB before block scan`
      );

      // In vault mode, vaultBridge DB records are stored under the source (vault) chain ID,
      // not the secondary chain being scanned here.
      const dbChainId = !chainConfigsRaw.enableLiberdusNetwork && chainId === chainConfigsRaw.secondaryChainConfig?.chainId
        ? chainConfigsRaw.vaultChain!.chainId
        : chainId;

      // Check DB first — tss-party shares the same DB and may have already recorded these nonces
      const dbTxs = TransactionDB.getTransactionsByNonceRange(dbChainId, tssSender, lastKnownNonce, chainNonce);
      const dbFinalizedNonces = new Set(
        dbTxs
          .filter(tx =>
            ((tx.status === TransactionDB.TransactionStatus.COMPLETED || tx.status === TransactionDB.TransactionStatus.FAILED) &&
              (tx.type === TransactionDB.TransactionType.BRIDGE_IN || tx.type === TransactionDB.TransactionType.BRIDGE_VAULT)) ||
            (tx.status === TransactionDB.TransactionStatus.REVERTED && tx.type === TransactionDB.TransactionType.BRIDGE_OUT)
          )
          .map(tx => tx.nonce!)
      );
      const missingNonces: number[] = [];
      // Check if every nonce in the gap is accounted for in DB
      let allGapResolved = true;
      for (let n = lastKnownNonce; n < chainNonce; n++) {
        if (!dbFinalizedNonces.has(n)) {
          allGapResolved = false;
          missingNonces.push(n);
        }
      }

      if (allGapResolved) {
        // All gap nonces already in DB — no block scan needed
        console.log(`[observer/failedtx] All gap nonces [${lastKnownNonce}–${chainNonce - 1}] resolved in DB, skipping block scan`);
        monitorState.failedTxNonces[senderKey] = chainNonce;
        monitorState.failedTxScanBlocks[chainKey] = currentBlock - BLOCK_CONFIRMATION_BUFFER;
        saveMonitorState();
        continue;
      }

      console.log(
        `[observer/failedtx] DB does not fully resolve nonce range [${lastKnownNonce}–${chainNonce - 1}] ` +
        `(missing nonce${missingNonces.length === 1 ? '' : 's'}: ${missingNonces.join(', ')}), ` +
        `scanning blocks ${fromBlock + 1}–${toBlock}`
      );

      const pendingMissingNonces = new Set(missingNonces);
      let scannedThroughBlock = fromBlock;
      let shouldRetryCurrentWindow = false;

      for (let blockNum = fromBlock + 1; blockNum <= toBlock && pendingMissingNonces.size > 0; blockNum++) {
        scannedThroughBlock = blockNum;
        const block = await observerChainRpc.withChainHttpProvider(
          chainId, (p) => p.getBlockWithTransactions(blockNum), { maxRetries: 3 });

        if (block) {
          for (const tx of block.transactions) {
            if (tx.from?.toLowerCase() !== tssSender) continue;
            if (tx.to?.toLowerCase() !== bridgeContract) continue;

            // Skip nonces already finalized in DB
            if (dbFinalizedNonces.has(tx.nonce)) continue;
            if (!pendingMissingNonces.has(tx.nonce)) continue;

            const receipt = await observerChainRpc.withChainHttpProvider(
              chainId, (p) => p.getTransactionReceipt(tx.hash), { maxRetries: 3 });
            if (!receipt) {
              shouldRetryCurrentWindow = true;
              continue;
            }

            let txId: string | null = null;
            try {
              const decoded = BRIDGE_IN_CALL_IFACE.decodeFunctionData("bridgeIn", tx.data);
              txId = normalizeTxId(decoded.txId as string);
            } catch {
              console.warn(`[observer/failedtx] Failed to decode calldata for tx ${tx.hash} nonce=${tx.nonce} on chain ${chainId}`);
            }

            if (txId) {
              const existing = TransactionDB.getTransactionById(txId);
              const status = receipt.status === 1
                ? getBridgeInSuccessStatus(existing?.type, existing?.chainId, chainId)
                : TransactionDB.TransactionStatus.FAILED;
              const statusLabel = TransactionDB.getStatusLabel(status);
              const result = TransactionDB.updateTransactionStatus(
                txId,
                status,
                tx.hash,
                tssSender,
                tx.nonce,
                null,
              );
              pendingMissingNonces.delete(tx.nonce);
              console.log(`[observer/failedtx] Marked ${txId} as ${statusLabel} (nonce=${tx.nonce}, hash=${tx.hash}) on chain ${chainId}: ${result}`);
            }
          }
        }
      }

      // Only advance the nonce baseline once we have scanned up to currentBlock
      if (shouldRetryCurrentWindow) {
        console.log(`[observer/failedtx] Missing receipt(s) encountered while scanning chain ${chainId}; retrying this window next interval without advancing state`);
      } else {
        monitorState.failedTxScanBlocks[chainKey] = scannedThroughBlock;
        saveMonitorState();
      }

      if (!shouldRetryCurrentWindow && toBlock >= currentBlock) {
        monitorState.failedTxNonces[senderKey] = chainNonce;
        saveMonitorState();
      } else if (!shouldRetryCurrentWindow) {
        console.log(`[observer/failedtx] Scan capped at ${MAX_FAILED_TX_SCAN_BLOCKS_PER_CYCLE} blocks, will continue next cycle`);
      }
    } catch (err) {
      console.error(`[observer/failedtx] Error for chain ${chainId}:`, err);
      allChainsSeeded = false;
    } finally {
      isFailedTxScanRunning.set(chainId, false);
    }
  }
  return allChainsSeeded;
}
