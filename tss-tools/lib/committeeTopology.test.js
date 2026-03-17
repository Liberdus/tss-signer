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
    extraArgs: ['--log_level', 'debug'],
  });

  assert.deepEqual(args, [
    'keygen',
    '--home',
    '/tmp/party-1',
    '--vault_name',
    'default',
    '--password',
    'vault-password',
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
    '--log_level',
    'debug',
  ]);
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
  testGetCommitteeTopologyUsesParsedDescribeOutput();
  console.log('committee topology tests passed');
}

main();
