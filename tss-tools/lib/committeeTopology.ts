const LOCAL_PEER_HOST = '127.0.0.1'
const LOCAL_LISTEN_PORT_BASE = 40000

export interface LocalPeerAddrsOptions {
  chainId: number
  parties: number
  partyIdx: number
  host?: string
}

export interface CommitteeTopologySnapshot {
  peerAddrs: string[]
  expectedPeers: string[]
  listenAddr?: string
  newListenAddr?: string
  peerId?: string
  moniker?: string
}

function getDeterministicListenPort(chainId: number, partyIdx: number): number {
  if (!Number.isInteger(chainId) || !Number.isInteger(partyIdx) || partyIdx < 1) {
    throw new Error(`Invalid deterministic listen port inputs: chainId=${chainId}, partyIdx=${partyIdx}`)
  }
  return LOCAL_LISTEN_PORT_BASE + (Math.abs(chainId) % 1000) * 10 + partyIdx
}

export function deriveLocalPeerAddrs(options: LocalPeerAddrsOptions): string[] {
  const {chainId, parties, partyIdx} = options
  const host = options.host || LOCAL_PEER_HOST
  if (!Number.isInteger(parties) || parties < 2) {
    throw new Error(`parties must be an integer >= 2, received ${parties}`)
  }
  if (!Number.isInteger(partyIdx) || partyIdx < 1 || partyIdx > parties) {
    throw new Error(`partyIdx must be within 1..${parties}, received ${partyIdx}`)
  }

  const peerAddrs: string[] = []
  for (let idx = 1; idx <= parties; idx += 1) {
    if (idx === partyIdx) {
      continue
    }
    peerAddrs.push(`/ip4/${host}/tcp/${getDeterministicListenPort(chainId, idx)}`)
  }
  return peerAddrs
}

export function extractCommitteeTopologyFromDescribeOutput(output: string): CommitteeTopologySnapshot {
  const marker = 'config of this vault:'
  const markerIndex = output.indexOf(marker)
  if (markerIndex === -1) {
    throw new Error('Unable to locate decrypted config in describe output')
  }

  const jsonText = output.slice(markerIndex + marker.length).trim()
  const parsed = JSON.parse(jsonText)
  const p2p = parsed?.p2p || {}

  return {
    peerAddrs: Array.isArray(p2p.peer_addrs) ? p2p.peer_addrs : [],
    expectedPeers: Array.isArray(p2p.peers) ? p2p.peers : [],
    listenAddr: typeof p2p.listen === 'string' ? p2p.listen : undefined,
    newListenAddr: typeof p2p.new_listen === 'string' ? p2p.new_listen : undefined,
    peerId: typeof parsed?.Id === 'string' ? parsed.Id : undefined,
    moniker: typeof parsed?.Moniker === 'string' ? parsed.Moniker : undefined,
  }
}
