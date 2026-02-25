import { ethers } from "ethers";
import * as TransactionDB from "../storage/transactiondb";
import { toEthereumAddress } from "../utils/transformAddress";
import { chainConfigsRaw, chainProviders, getChainConfigById } from "../config";
import { monitorState, saveMonitorState } from "./state";

// ---------------------------------------------------------------------------
// Adaptive-batch queryFilter constants
// ---------------------------------------------------------------------------

const BRIDGE_OUT_EVENT_ABI =
  "event BridgedOut(address indexed from, uint256 amount, address indexed targetAddress, uint256 indexed chainId, uint256 timestamp)";

const INITIAL_BATCH_SIZE = 1000;
const MIN_BATCH_SIZE = 100;
const BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;
const MAX_RETRIES_PER_BATCH = 5;

let isQueryFilterRunning = false;
const chainBatchSizes = new Map<number, number>();

// ---------------------------------------------------------------------------
// Ethereum monitoring — queryFilter only (no WebSocket)
// ---------------------------------------------------------------------------

export async function monitorEthereumTransactionsQueryFilter(): Promise<void> {
  if (isQueryFilterRunning) {
    console.log("[coordinator/queryFilter] Previous run still active, skipping");
    return;
  }
  isQueryFilterRunning = true;

  try {
    for (const [chainId, provider] of chainProviders.entries()) {
      // In vault mode only vaultChain emits events — skip secondaryChainConfig
      if (
        !chainConfigsRaw.enableLiberdusNetwork &&
        chainId === chainConfigsRaw.secondaryChainConfig?.chainId
      )
        continue;

      const chainConfig = getChainConfigById(chainId);
      if (!chainConfig) continue;
      const chainName = chainConfig.name;

      try {
        const newestBlock = await provider.getBlockNumber();
        const savedBlock =
          monitorState.blocks[chainId.toString()] ??
          (chainConfig.deploymentBlock ?? 0);

        if (savedBlock >= newestBlock) {
          console.log(
            `[coordinator/queryFilter] Already up to date for ${chainName}, skipping`
          );
          continue;
        }

        const fromBlock = Math.max(
          chainConfig.deploymentBlock ?? 0,
          savedBlock - 10 // small overlap for redundancy
        );
        const toBlock = newestBlock;
        console.log(
          `[coordinator/queryFilter] Scanning ${chainName} blocks ${fromBlock}–${toBlock}`
        );

        const bridgeInterface = new ethers.utils.Interface([
          BRIDGE_OUT_EVENT_ABI,
        ]);
        const contract = new ethers.Contract(
          chainConfig.contractAddress,
          bridgeInterface,
          provider
        );

        let batchSize = chainBatchSizes.get(chainId) ?? INITIAL_BATCH_SIZE;
        let cursor = fromBlock;
        let retryCount = 0;
        let retryDelay = BASE_DELAY_MS;

        while (cursor <= toBlock) {
          const batchEnd = Math.min(cursor + batchSize - 1, toBlock);
          let events: ethers.Event[];

          try {
            events = await contract.queryFilter(
              contract.filters.BridgedOut(),
              cursor,
              batchEnd
            );
            retryCount = 0;
            retryDelay = BASE_DELAY_MS;
          } catch (error: any) {
            const isRateLimit =
              error?.error?.code === -32005 ||
              error?.code === -32005 ||
              error?.message?.includes("limit exceeded");

            if (isRateLimit) {
              if (batchSize > MIN_BATCH_SIZE) {
                batchSize = Math.max(Math.floor(batchSize / 2), MIN_BATCH_SIZE);
                chainBatchSizes.set(chainId, batchSize);
                console.warn(
                  `[coordinator/queryFilter] RPC limit on ${chainName}, reducing batch to ${batchSize}`
                );
                await new Promise((r) => setTimeout(r, retryDelay));
                continue;
              }
              retryCount++;
              if (retryCount <= MAX_RETRIES_PER_BATCH) {
                retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
                console.warn(
                  `[coordinator/queryFilter] Rate limited on ${chainName}, retry ${retryCount}/${MAX_RETRIES_PER_BATCH} after ${retryDelay}ms`
                );
                await new Promise((r) => setTimeout(r, retryDelay));
                continue;
              }
              console.error(
                `[coordinator/queryFilter] Rate limit retries exhausted for ${chainName} at block ${cursor}, resuming next interval`
              );
              break;
            }
            throw error;
          }

          if (events.length > 0) {
            console.log(
              `[coordinator/queryFilter] Found ${events.length} BridgedOut events on ${chainName} in blocks ${cursor}–${batchEnd}`
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

            const txId = event.transactionHash;

            // Dedup via DB
            const existing = await TransactionDB.getTransactionById(txId);
            if (existing) continue;

            const txType = !chainConfigsRaw.enableLiberdusNetwork
              ? TransactionDB.TransactionType.BRIDGE_VAULT
              : TransactionDB.TransactionType.BRIDGE_OUT;

            const tx: TransactionDB.Transaction = {
              txId: txId.toLowerCase(),
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
              `[coordinator/queryFilter] Saved ${
                txType === TransactionDB.TransactionType.BRIDGE_VAULT
                  ? "BRIDGE_VAULT"
                  : "BRIDGE_OUT"
              } tx ${txId} from ${chainName}`
            );
          }

          // Advance cursor and persist block state
          cursor = batchEnd + 1;
          monitorState.blocks[chainId.toString()] = batchEnd;
          saveMonitorState();

          // Gradually recover batch size after a successful batch
          if (batchSize < INITIAL_BATCH_SIZE) {
            batchSize = Math.min(batchSize * 2, INITIAL_BATCH_SIZE);
            chainBatchSizes.set(chainId, batchSize);
          }

          if (cursor <= toBlock) {
            await new Promise((r) => setTimeout(r, BASE_DELAY_MS));
          }
        }
      } catch (error) {
        console.error(
          `[coordinator/queryFilter] Error for ${chainName}:`,
          error
        );
      }
    }
  } finally {
    isQueryFilterRunning = false;
  }
}
