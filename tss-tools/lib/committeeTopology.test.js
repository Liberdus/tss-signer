const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const ts = require('typescript');

function requireTypeScriptModule(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filePath,
  });
  const tsModule = new Module(filePath, module);
  tsModule.filename = filePath;
  tsModule.paths = Module._nodeModulePaths(path.dirname(filePath));
  tsModule._compile(transpiled.outputText, filePath);
  return tsModule.exports;
}

const bnbTss = requireTypeScriptModule(path.join(__dirname, 'bnbTss.ts'));
const committeeTopology = requireTypeScriptModule(path.join(__dirname, 'committeeTopology.ts'));

function testDeriveLocalPeerAddrs() {
  const peerAddrs = committeeTopology.deriveLocalPeerAddrs({
    chainId: 31338,
    parties: 3,
    partyIdx: 2,
  });

  assert.deepEqual(peerAddrs, [
    '/ip4/127.0.0.1/tcp/43381',
    '/ip4/127.0.0.1/tcp/43383',
  ]);
}

function testExtractCommitteeTopologyFromDescribeOutput() {
  const output = `address of this vault: bnb1test\nconfig of this vault:\n{\n  "p2p": {\n    "peer_addrs": ["/ip4/127.0.0.1/tcp/43381"],\n    "peers": ["party-1@peerid1"]\n  }\n}`;
  const parsed = committeeTopology.extractCommitteeTopologyFromDescribeOutput(output);

  assert.deepEqual(parsed, {
    peerAddrs: ['/ip4/127.0.0.1/tcp/43381'],
    expectedPeers: ['party-1@peerid1'],
  });
}

function testBuildKeygenArgsIncludesPeerAddrs() {
  const args = bnbTss.buildKeygenArgs({
    home: '/tmp/party-1',
    vaultName: 'default',
    password: 'vault-password',
    channelId: '12369B44E38',
    channelPassword: 'session-password',
    threshold: 1,
    parties: 3,
    peerAddrs: ['/ip4/127.0.0.1/tcp/43382', '/ip4/127.0.0.1/tcp/43383'],
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

function testDeriveLocalRegroupPeerAddrsForCarryOverOldMember() {
  const peerAddrs = bnbTss.deriveLocalRegroupPeerAddrs({
    chainId: 31338,
    parties: 3,
    threshold: 1,
    newParties: 3,
    partyIdx: 1,
    isOld: true,
  });

  assert.deepEqual(peerAddrs, [
    '/ip4/127.0.0.1/tcp/43381',
    '/ip4/127.0.0.1/tcp/43382',
    '/ip4/127.0.0.1/tcp/44382',
    '/ip4/127.0.0.1/tcp/43383',
  ]);
}

function testDeriveLocalRegroupPeerAddrsForNewOnlyMember() {
  const peerAddrs = bnbTss.deriveLocalRegroupPeerAddrs({
    chainId: 31338,
    parties: 3,
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

function testBuildRegroupWrapperArgsUsesExplicitOverrides() {
  const extraArgs = ['--p2p.new_peer_addrs', '/ip4/127.0.0.1/tcp/49991,/ip4/127.0.0.1/tcp/49992'];
  assert.equal(
    extraArgs.some((arg) => arg === '--p2p.new_peer_addrs' || arg.startsWith('--p2p.new_peer_addrs=')),
    true,
  );
}

function testDeriveLocalRegroupPeerAddrsHasNoDuplicates() {
  const peerAddrs = bnbTss.deriveLocalRegroupPeerAddrs({
    chainId: 31338,
    parties: 3,
    threshold: 1,
    newParties: 3,
    partyIdx: 2,
    isOld: true,
  });

  assert.equal(new Set(peerAddrs).size, peerAddrs.length);
}

function testDeriveLocalRegroupPeerAddrsRejectsMixedWrapperRoles() {
  assert.throws(
    () =>
      bnbTss.deriveLocalRegroupPeerAddrs({
        chainId: 31338,
        parties: 3,
        threshold: 1,
        newParties: 3,
        partyIdx: 1,
        isOld: true,
        isNewMember: true,
      }),
    /mutually exclusive/,
  );
}

function testGetCommitteeTopologyUsesParsedDescribeOutput() {
  const parsed = bnbTss.getCommitteeTopology({
    describeOutput: `config of this vault:\n{"p2p":{"peer_addrs":["/ip4/127.0.0.1/tcp/43382"],"peers":["party-2@peerid2"]}}`,
  });

  assert.deepEqual(parsed, {
    peerAddrs: ['/ip4/127.0.0.1/tcp/43382'],
    expectedPeers: ['party-2@peerid2'],
  });
}

function main() {
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
