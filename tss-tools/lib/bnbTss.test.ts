import assert from 'node:assert/strict';
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {getMoniker, getPartyHome, resolveMisePlatform} from './bnbTss';

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

function main(): void {
  testResolveMisePlatformSupportsDarwinArm64();
  testResolveMisePlatformSupportsLinuxX64();
  testResolveMisePlatformSupportsLinuxArm64();
  testResolveMisePlatformRejectsUnsupportedPlatforms();
  testGetPartyHomeUsesCleanDefaultPathWhenRequested();
  testGetPartyHomeFallsBackToLegacyPartyOnePath();
  testGetPartyHomeKeepsIndexedManualPath();
  testGetMonikerKeepsIndexedFormat();
  console.log('bnbTss tests passed');
}

main();
