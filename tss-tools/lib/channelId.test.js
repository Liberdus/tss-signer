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

const {deriveDeterministicChannelId} = requireTypeScriptModule(path.join(__dirname, 'channelId.ts'));

function testDeterministicChannelIdFormat() {
  const txId = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const txTimestampMs = 1_710_000_000_000;
  const channelId = deriveDeterministicChannelId(txId, txTimestampMs, 1_710_000_100);
  const expectedExpiryHex = (Math.floor(txTimestampMs / 1000) + 1800).toString(16).toUpperCase().padStart(8, '0');

  assert.equal(channelId.length, 11);
  assert.equal(channelId.slice(0, 3), 'ABC');
  assert.equal(channelId.slice(3), expectedExpiryHex);
}

function testDeterministicChannelIdAdvancesExpiredTimestamp() {
  const txId = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const txTimestampMs = 1_710_000_000_000;
  const nowSec = 1_710_010_000;
  const channelId = deriveDeterministicChannelId(txId, txTimestampMs, nowSec);
  const expirySec = Number.parseInt(channelId.slice(3), 16);

  assert.equal(channelId.slice(0, 3), '123');
  assert.ok(expirySec > nowSec);
  assert.equal((expirySec - (Math.floor(txTimestampMs / 1000) + 1800)) % 1800, 0);
}

function testDeterministicChannelIdRejectsInvalidInputs() {
  assert.throws(() => deriveDeterministicChannelId('nope', Date.now()), /Invalid normalized txId/);
  assert.throws(
    () => deriveDeterministicChannelId('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 0),
    /Invalid txTimestampMs/,
  );
}

function main() {
  testDeterministicChannelIdFormat();
  testDeterministicChannelIdAdvancesExpiredTimestamp();
  testDeterministicChannelIdRejectsInvalidInputs();
  console.log('channel id tests passed');
}

main();
