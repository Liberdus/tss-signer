import assert from 'node:assert/strict';
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {getIpBasedMoniker, getMoniker, getPartyHome, readStoredListenAddr, resolveMisePlatform} from './bnbTss';

function testResolveMisePlatformSupportsDarwinArm64(): void {
  assert.equal(resolveMisePlatform('darwin', 'arm64'), 'darwin-arm64');
}

function testResolveMisePlatformSupportsLinuxX64(): void {
  assert.equal(resolveMisePlatform('linux', 'x64'), 'linux-x64');
}

function testResolveMisePlatformSupportsLinuxArm64(): void {
  assert.equal(resolveMisePlatform('linux', 'arm64'), 'linux-arm64');
}

function testResolveMisePlatformRejectsUnsupportedPlatforms(): void {
  assert.throws(
    () => resolveMisePlatform('win32', 'x64'),
    /Windows is not supported/,
  );
  assert.throws(
    () => resolveMisePlatform('darwin', 'x64'),
    /Unsupported platform/,
  );
}

function testGetPartyHomeUsesCleanDefaultPathWhenRequested(): void {
  const signerRoot = path.join(path.sep, 'tmp', 'tss')
  assert.equal(
    getPartyHome({
      signerRoot,
      chainId: 201,
      useDefaultSlotPath: true,
    }),
    path.resolve(signerRoot, 'keystores', 'bnbtss', 'chain-201'),
  )
}

function testGetPartyHomeFallsBackToLegacyPartyOnePath(): void {
  const signerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-home-fallback-'))
  try {
    const legacyConfigPath = path.join(signerRoot, 'keystores', 'bnbtss', 'party-1', 'chain-201', 'default', 'config.json')
    fs.mkdirSync(path.dirname(legacyConfigPath), {recursive: true})
    fs.writeFileSync(legacyConfigPath, '{}', 'utf8')
    assert.equal(
      getPartyHome({
        signerRoot,
        chainId: 201,
        useDefaultSlotPath: true,
      }),
      path.join(signerRoot, 'keystores', 'bnbtss', 'party-1', 'chain-201'),
    )
  } finally {
    fs.rmSync(signerRoot, {recursive: true, force: true})
  }
}

function testGetPartyHomeKeepsIndexedManualPath(): void {
  const signerRoot = path.join(path.sep, 'tmp', 'tss')
  assert.equal(
    getPartyHome({
      signerRoot,
      partyIdx: 4,
      chainId: 201,
    }),
    path.resolve(signerRoot, 'keystores', 'bnbtss', 'party-4', 'chain-201'),
  )
}

function testGetMonikerKeepsIndexedFormat(): void {
  assert.equal(getMoniker(4, 201), 'party-4-chain-201')
}

function testGetIpBasedMonikerUsesStableIpFormat(): void {
  assert.equal(getIpBasedMoniker(56, '69.164.244.104'), 'ip-69-164-244-104-chain-56')
}

function testGetIpBasedMonikerRejectsInvalidIpv4(): void {
  assert.throws(() => getIpBasedMoniker(56, 'not-an-ip'), /Invalid IPv4 address/)
}

function testReadStoredListenAddrReadsOuterConfigListen(): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-listen-read-'))
  try {
    const vaultDir = path.join(home, 'default')
    fs.mkdirSync(vaultDir, {recursive: true})
    fs.writeFileSync(
      path.join(vaultDir, 'config.json'),
      JSON.stringify({listen: '/ip4/0.0.0.0/tcp/42011'}),
      'utf8',
    )
    assert.equal(readStoredListenAddr(home), '/ip4/0.0.0.0/tcp/42011')
  } finally {
    fs.rmSync(home, {recursive: true, force: true})
  }
}

function main(): void {
  testResolveMisePlatformSupportsDarwinArm64();
  testResolveMisePlatformSupportsLinuxX64();
  testResolveMisePlatformSupportsLinuxArm64();
  testResolveMisePlatformRejectsUnsupportedPlatforms();
  testGetPartyHomeUsesCleanDefaultPathWhenRequested();
  testGetPartyHomeFallsBackToLegacyPartyOnePath();
  testGetPartyHomeKeepsIndexedManualPath();
  testGetMonikerKeepsIndexedFormat();
  testGetIpBasedMonikerUsesStableIpFormat();
  testGetIpBasedMonikerRejectsInvalidIpv4();
  testReadStoredListenAddrReadsOuterConfigListen();
  console.log('bnbTss tests passed');
}

main();
