import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildObserverUrls,
  getPeerObserverUrls,
  normalizeObserverUrl,
  observerPeerConfigRaw,
  setSelfObserverUrl,
} from './observerPeers';
import { paramsConfigRaw } from '../config';
import { resolveProjectRoot } from './paths';

function readExpectedConfiguredObserverUrls(): string[] {
  const observerListPath = path.join(resolveProjectRoot(), 'observer-list.json');
  if (!fs.existsSync(observerListPath)) return [];

  const raw = JSON.parse(fs.readFileSync(observerListPath, 'utf8')) as unknown;
  assert.ok(Array.isArray(raw));
  return raw
    .map((entry) => {
      assert.equal(typeof entry, 'string');
      return normalizeObserverUrl(entry);
    })
    .filter(Boolean);
}

function testConfiguredObserverUrls(): void {
  const expectedObserverUrls = readExpectedConfiguredObserverUrls();
  assert.deepEqual(observerPeerConfigRaw.observerUrls, expectedObserverUrls);
}

function testObserverPartyCount(): void {
  const expectedObserverUrls = readExpectedConfiguredObserverUrls();
  assert.equal(
    observerPeerConfigRaw.partyCount,
    expectedObserverUrls.length > 0 ? expectedObserverUrls.length : paramsConfigRaw.parties,
  );
}

function testBuildObserverUrls(): void {
  const expectedObserverUrls = readExpectedConfiguredObserverUrls();
  const expectedUrls = expectedObserverUrls.length > 0
    ? expectedObserverUrls
    : Array.from({ length: paramsConfigRaw.parties }, (_, index) => `http://127.0.0.1:${8101 + index}`);
  assert.deepEqual(buildObserverUrls(), expectedUrls);
}

function testPeerSelectionUsesPartyIndex(): void {
  const observerUrls = buildObserverUrls();
  if (observerUrls.length < 2) return;

  const previousPartyIndex = process.env.PARTY_INDEX;
  process.env.PARTY_INDEX = '2';
  try {
    assert.deepEqual(
      getPeerObserverUrls(),
      observerUrls.filter((_, index) => index !== 1),
    );
  } finally {
    if (previousPartyIndex == null) {
      delete process.env.PARTY_INDEX;
    } else {
      process.env.PARTY_INDEX = previousPartyIndex;
    }
  }
}

function testPeerSelectionUsesConfiguredSelfUrl(): void {
  const observerUrls = buildObserverUrls();
  if (observerUrls.length < 2) return;

  setSelfObserverUrl(`${observerUrls[0]}/`);
  assert.deepEqual(
    getPeerObserverUrls(),
    observerUrls.slice(1),
  );
}

function main(): void {
  testConfiguredObserverUrls();
  testObserverPartyCount();
  testBuildObserverUrls();
  testPeerSelectionUsesPartyIndex();
  testPeerSelectionUsesConfiguredSelfUrl();
  console.log('observer peers tests passed');
}

main();
