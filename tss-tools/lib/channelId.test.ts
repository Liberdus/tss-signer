import assert from 'node:assert/strict';
import {
  deriveDeterministicChannelId,
  deriveDeterministicChannelPassword,
} from './channelId';

function testDeterministicChannelIdFormat(): void {
  const txId = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  const txTimestampMs = 1_710_000_000_000;
  const channelId = deriveDeterministicChannelId(txId, txTimestampMs, 1_710_000_100);
  const expectedExpiryHex = (Math.floor(txTimestampMs / 1000) + 1800).toString(16).toUpperCase().padStart(8, '0');

  assert.equal(channelId.length, 11);
  assert.equal(channelId.slice(0, 3), 'ABC');
  assert.equal(channelId.slice(3), expectedExpiryHex);
}

function testDeterministicChannelIdAdvancesExpiredTimestamp(): void {
  const txId = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const txTimestampMs = 1_710_000_000_000;
  const nowSec = 1_710_010_000;
  const channelId = deriveDeterministicChannelId(txId, txTimestampMs, nowSec);
  const expirySec = Number.parseInt(channelId.slice(3), 16);

  assert.equal(channelId.slice(0, 3), '123');
  assert.ok(expirySec > nowSec);
  assert.equal((expirySec - (Math.floor(txTimestampMs / 1000) + 1800)) % 1800, 0);
}

function testDeterministicChannelIdRejectsInvalidInputs(): void {
  assert.throws(() => deriveDeterministicChannelId('nope', Date.now()), /Invalid normalized txId/);
  assert.throws(
    () => deriveDeterministicChannelId('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', 0),
    /Invalid txTimestampMs/,
  );
}

function testDeterministicChannelPassword(): void {
  const channelPassword = deriveDeterministicChannelPassword(
    'ABC65EC8E88',
    '69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc',
  );
  
  assert.equal(channelPassword.length, 64);
  assert.match(channelPassword, /^[0-9a-f]+$/);
  assert.equal(
    channelPassword,
    'ed4414fdc567a53fe22fb53de2da69149a897af1ae804fd8ac41b50a14cacc4f',
  );
}

function main(): void {
  testDeterministicChannelIdFormat();
  testDeterministicChannelIdAdvancesExpiredTimestamp();
  testDeterministicChannelIdRejectsInvalidInputs();
  testDeterministicChannelPassword();
  console.log('channel id tests passed');
}

main();
