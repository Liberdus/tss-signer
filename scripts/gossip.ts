import axios from "axios";
import { chainConfigsRaw, getChainConfigById } from "../shared/config";
import { EVMBridgeInGossipPayload } from "../shared/utils/evmBridgeInGossip";
import { LiberdusBridgeInGossipPayload } from "../shared/utils/liberdusBridgeInGossip";
import { getPeerObserverUrls } from "../shared/utils/observerPeers";

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

export async function gossipBridgeIn(
  route: GossipBridgeInRoute,
  payload: GossipBridgeInPayload,
  peerCount: number,
  senderPartyIdx: number,
): Promise<void> {
  const peerUrls = getPeerObserverUrls(peerCount, senderPartyIdx);
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
    ? `[gossip/${routeTag}] ${routeLabel} BridgeIn submitted fanout start sourceTxId=${liberdusPayload.sourceTxId} liberdusTxId=${liberdusPayload.liberdusTxId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} peers=${peerUrls.length} senderParty=${liberdusPayload.senderPartyIdx}`
    : `[gossip/${routeTag}] ${routeLabel} BridgeIn submitted fanout start txId=${evmPayload.bridgeInTxId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} peers=${peerUrls.length} senderParty=${evmPayload.senderPartyIdx}`;

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
          `[gossip/${routeTag}] failed to send submitted ${routeLabel} BridgeIn tx sourceTxId=${liberdusPayload.sourceTxId} liberdusTxId=${liberdusPayload.liberdusTxId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} to ${endpoint}: ${reason}`,
        );
      } else {
        console.warn(
          `[gossip/${routeTag}] failed to send submitted ${routeLabel} BridgeIn tx ${evmPayload.bridgeInTxId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} to ${endpoint}: ${reason}`,
        );
      }
    }
  });
  await Promise.all(requests);
  if (isLiberdusPayload) {
    console.log(
      `[gossip/${routeTag}] ${routeLabel} BridgeIn submitted fanout complete sourceTxId=${liberdusPayload.sourceTxId} liberdusTxId=${liberdusPayload.liberdusTxId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} delivered=${delivered}/${peerUrls.length}`,
    );
  } else {
    console.log(
      `[gossip/${routeTag}] ${routeLabel} BridgeIn submitted fanout complete txId=${evmPayload.bridgeInTxId} sourceChain=${sourceChainLabel} destinationChain=${destinationChainLabel} delivered=${delivered}/${peerUrls.length}`,
    );
  }
}
