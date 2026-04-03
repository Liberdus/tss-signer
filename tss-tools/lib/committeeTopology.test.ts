import assert from 'node:assert/strict';
import * as bnbTss from './bnbTss';
import {
  deriveLocalPeerAddrs,
  extractCommitteeTopologyFromDescribeOutput,
} from './committeeTopology';

function testDeriveLocalPeerAddrs(): void {
  const peerAddrs = deriveLocalPeerAddrs({
    chainId: 31338,
    parties: 3,
    partyIdx: 2,
  });

  assert.deepEqual(peerAddrs, [
    '/ip4/127.0.0.1/tcp/43381',
    '/ip4/127.0.0.1/tcp/43383',
  ]);
}

function testExtractCommitteeTopologyFromDescribeOutput(): void {
  const output = `address of this vault: bnb1test\nconfig of this vault:\n{\n  "p2p": {\n    "listen": "/ip4/0.0.0.0/tcp/43382",\n    "new_listen": "",\n    "peer_addrs": ["/ip4/127.0.0.1/tcp/43381"],\n    "peers": ["party-1@peerid1"]\n  },\n  "Id": "peerid2",\n  "Moniker": "party-2"\n}`;
  const parsed = extractCommitteeTopologyFromDescribeOutput(output);

  assert.deepEqual(parsed, {
    peerAddrs: ['/ip4/127.0.0.1/tcp/43381'],
    expectedPeers: ['party-1@peerid1'],
    listenAddr: '/ip4/0.0.0.0/tcp/43382',
    newListenAddr: '',
    peerId: 'peerid2',
    moniker: 'party-2',
  });
}

function testBuildKeygenArgsIncludesPeerAddrs(): void {
  const args = bnbTss.buildKeygenArgs({
    home: '/tmp/party-1',
    vaultName: 'default',
    password: 'vault-password',
    logLevel: 'debug',
    channelId: '12369B44E38',
    channelPassword: 'session-password',
    threshold: 1,
    parties: 3,
    peerAddrs: ['/ip4/127.0.0.1/tcp/43382', '/ip4/127.0.0.1/tcp/43383'],
    extraArgs: [],
  });

  assert.deepEqual(args, [
    'keygen',
    '--home',
    '/tmp/party-1',
    '--vault_name',
    'default',
    '--password',
    'vault-password',
    '--log_level',
    'debug',
    '--channel_id',
    '12369B44E38',
    '--channel_password',
    'session-password',
    '--threshold',
    '1',
    '--parties',
    '3',
    '--p2p.peer_addrs',
    '/ip4/127.0.0.1/tcp/43382,/ip4/127.0.0.1/tcp/43383',
  ]);
}

function testDeriveLocalRegroupPeerAddrsForCarryOverOldMember(): void {
  const peerAddrs = bnbTss.deriveLocalRegroupPeerAddrs({
    chainId: 31338,
    parties: 2,
    threshold: 1,
    newParties: 3,
    partyIdx: 1,
    isOld: true,
  });

  assert.deepEqual(peerAddrs, [
    '/ip4/127.0.0.1/tcp/43382',
    '/ip4/127.0.0.1/tcp/44381',
    '/ip4/127.0.0.1/tcp/44382',
    '/ip4/127.0.0.1/tcp/43383',
  ]);
}

function testDeriveLocalRegroupPeerAddrsForNewOnlyMember(): void {
  const peerAddrs = bnbTss.deriveLocalRegroupPeerAddrs({
    chainId: 31338,
    parties: 2,
    threshold: 1,
    newParties: 3,
    partyIdx: 3,
    isNewMember: true,
  });

  assert.deepEqual(peerAddrs, [
    '/ip4/127.0.0.1/tcp/43381',
    '/ip4/127.0.0.1/tcp/43382',
    '/ip4/127.0.0.1/tcp/44381',
    '/ip4/127.0.0.1/tcp/44382',
  ]);
}

function testBuildRegroupWrapperArgsUsesExplicitOverrides(): void {
  const extraArgs = ['--p2p.new_peer_addrs', '/ip4/127.0.0.1/tcp/49991,/ip4/127.0.0.1/tcp/49992'];
  assert.equal(
    extraArgs.some((arg) => arg === '--p2p.new_peer_addrs' || arg.startsWith('--p2p.new_peer_addrs=')),
    true,
  );
}

function testDeriveLocalRegroupPeerAddrsHasNoDuplicates(): void {
  const peerAddrs = bnbTss.deriveLocalRegroupPeerAddrs({
    chainId: 31338,
    parties: 2,
    threshold: 1,
    newParties: 3,
    partyIdx: 2,
    isOld: true,
  });

  assert.equal(new Set(peerAddrs).size, peerAddrs.length);
}

function testDeriveLocalRegroupPeerAddrsRejectsMixedWrapperRoles(): void {
  assert.throws(
    () =>
      bnbTss.deriveLocalRegroupPeerAddrs({
        chainId: 31338,
        parties: 2,
        threshold: 1,
        newParties: 3,
        partyIdx: 1,
        isOld: true,
        isNewMember: true,
      }),
    /mutually exclusive/,
  );
}

function testGetCommitteeTopologyUsesParsedDescribeOutput(): void {
  const parsed = bnbTss.getCommitteeTopology({
    partyIdx: 1,
    chainId: 31338,
    describeOutput: `config of this vault:\n{"p2p":{"peer_addrs":["/ip4/127.0.0.1/tcp/43382"],"peers":["party-2@peerid2"]}}`,
  });

  assert.deepEqual(parsed, {
    peerAddrs: ['/ip4/127.0.0.1/tcp/43382'],
    expectedPeers: ['party-2@peerid2'],
    listenAddr: undefined,
    newListenAddr: undefined,
    peerId: undefined,
    moniker: undefined,
  });
}

function main(): void {
  testDeriveLocalPeerAddrs();
  testExtractCommitteeTopologyFromDescribeOutput();
  testBuildKeygenArgsIncludesPeerAddrs();
  testDeriveLocalRegroupPeerAddrsForCarryOverOldMember();
  testDeriveLocalRegroupPeerAddrsForNewOnlyMember();
  testBuildRegroupWrapperArgsUsesExplicitOverrides();
  testDeriveLocalRegroupPeerAddrsHasNoDuplicates();
  testDeriveLocalRegroupPeerAddrsRejectsMixedWrapperRoles();
  testGetCommitteeTopologyUsesParsedDescribeOutput();
  console.log('committee topology tests passed');
}

main();
