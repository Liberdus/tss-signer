import axios from "axios";
import { chainConfigsRaw, getChainConfigById } from "../shared/config";
import { EVMBridgeInGossipPayload } from "../shared/utils/evmBridgeInGossip";
import { LiberdusBridgeInGossipPayload } from "../shared/utils/liberdusBridgeInGossip";
import { getCachedPeerObserverUrls } from "../shared/utils/observerPeers";

function getAxiosErrorMessage(error: unknown): string {
  return axios.isAxiosError(error)
    ? (error.cause instanceof Error ? error.cause.message : error.message)
    : (error instanceof Error ? error.message : String(error));
}

function getChainName(chainId: number): string {
  const cfg = getChainConfigById(chainConfigsRaw, chainId);
  return cfg?.name ?? `chainId=${chainId}`;
}

export type GossipBridgeInPayload = EVMBridgeInGossipPayload | LiberdusBridgeInGossipPayload;
export type GossipBridgeInRoute = "evm" | "liberdus";

function logLiberdusGossip(
  phase: "start" | "failed" | "complete",
  payload: LiberdusBridgeInGossipPayload,
  sourceChainLabel: string,
  peers: number,
  options?: { endpoint?: string; reason?: string; delivered?: number },
): void {
  const destinationChainLabel = "Liberdus";
  if (phase === "start") {
    console.log(
      `[gossip/liberdus] Liberdus BridgeIn submitted fanout start txId=${payload.txId} receiptId=${payload.receiptId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} peers=${peers}`,
    );
    return;
  }
  if (phase === "failed") {
    console.warn(
      `[gossip/liberdus] failed to send submitted Liberdus BridgeIn tx txId=${payload.txId} receiptId=${payload.receiptId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} to ${options?.endpoint}: ${options?.reason}`,
    );
    return;
  }
  console.log(
    `[gossip/liberdus] Liberdus BridgeIn submitted fanout complete txId=${payload.txId} receiptId=${payload.receiptId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} delivered=${options?.delivered}/${peers}`,
  );
}

function logEvmGossip(
  phase: "start" | "failed" | "complete",
  payload: EVMBridgeInGossipPayload,
  destinationChainLabel: string,
  peers: number,
  options?: { endpoint?: string; reason?: string; delivered?: number },
): void {
  if (phase === "start") {
    console.log(
      `[gossip/evm] EVM BridgeIn submitted fanout start txId=${payload.txId} receiptId=${payload.receiptId} sourceChain=Liberdus destinationChain=${destinationChainLabel} peers=${peers}`,
    );
    return;
  }
  if (phase === "failed") {
    console.warn(
      `[gossip/evm] failed to send submitted EVM BridgeIn tx txId=${payload.txId} receiptId=${payload.receiptId} sourceChain=Liberdus destinationChain=${destinationChainLabel} to ${options?.endpoint}: ${options?.reason}`,
    );
    return;
  }
  console.log(
    `[gossip/evm] EVM BridgeIn submitted fanout complete txId=${payload.txId} receiptId=${payload.receiptId} sourceChain=Liberdus destinationChain=${destinationChainLabel} delivered=${options?.delivered}/${peers}`,
  );
}

export async function gossipBridgeIn(
  route: GossipBridgeInRoute,
  payload: GossipBridgeInPayload,
  peerCount: number,
  selfObserverUrl?: string,
): Promise<void> {
  const peerUrls = getCachedPeerObserverUrls(peerCount, { selfObserverUrl });
  if (peerUrls.length === 0) return;

  const isLiberdusPayload = route === "liberdus";
  const liberdusPayload = payload as LiberdusBridgeInGossipPayload;
  const evmPayload = payload as EVMBridgeInGossipPayload;
  const routeLabel = isLiberdusPayload ? "Liberdus" : "EVM";
  const routeTag = isLiberdusPayload ? "liberdus" : "evm";
  const endpointPath = isLiberdusPayload
    ? "/bridgein/liberdus/submitted"
    : "/bridgein/evm/submitted";
  const sourceChainLabel = isLiberdusPayload
    ? `${getChainName(liberdusPayload.sourceChainId)}(${liberdusPayload.sourceChainId})`
    : `${getChainName(evmPayload.sourceChainId)}(${evmPayload.sourceChainId})`;
  const destinationChainLabel = isLiberdusPayload
    ? "Liberdus"
    : `${getChainName(evmPayload.destinationChainId)}(${evmPayload.destinationChainId})`;
  const startMsg = isLiberdusPayload
    ? `[gossip/${routeTag}] ${routeLabel} BridgeIn submitted fanout start txId=${liberdusPayload.txId} receiptId=${liberdusPayload.receiptId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} peers=${peerUrls.length}`
    : `[gossip/${routeTag}] ${routeLabel} BridgeIn submitted fanout start txId=${evmPayload.txId} receiptId=${evmPayload.receiptId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} peers=${peerUrls.length}`;

  console.log(startMsg);
  let delivered = 0;
  const requests = peerUrls.map(async (baseUrl) => {
    const endpoint = `${baseUrl}${endpointPath}`;
    try {
      await axios.post(endpoint, payload, { timeout: 5000 });
      delivered++;
    } catch (error) {
      const reason = getAxiosErrorMessage(error);
      if (isLiberdusPayload) {
        console.warn(
          `[gossip/${routeTag}] failed to send submitted ${routeLabel} BridgeIn tx txId=${liberdusPayload.txId} receiptId=${liberdusPayload.receiptId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} to ${endpoint}: ${reason}`,
        );
      } else {
        console.warn(
          `[gossip/${routeTag}] failed to send submitted ${routeLabel} BridgeIn tx txId=${evmPayload.txId} receiptId=${evmPayload.receiptId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} to ${endpoint}: ${reason}`,
        );
      }
    }
  });
  await Promise.all(requests);
  if (isLiberdusPayload) {
    console.log(
      `[gossip/${routeTag}] ${routeLabel} BridgeIn submitted fanout complete txId=${liberdusPayload.txId} receiptId=${liberdusPayload.receiptId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} delivered=${delivered}/${peerUrls.length}`,
    );
  } else {
    console.log(
      `[gossip/${routeTag}] ${routeLabel} BridgeIn submitted fanout complete txId=${evmPayload.txId} receiptId=${evmPayload.receiptId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} delivered=${delivered}/${peerUrls.length}`,
    );
  }
}
