import assert from 'node:assert/strict';
import {resolveMisePlatform} from './bnbTss';

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

function main(): void {
  testResolveMisePlatformSupportsDarwinArm64();
  testResolveMisePlatformSupportsLinuxX64();
  testResolveMisePlatformSupportsLinuxArm64();
  testResolveMisePlatformRejectsUnsupportedPlatforms();
  console.log('bnbTss tests passed');
}

main();
