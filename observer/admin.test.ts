import assert from "node:assert/strict";
import {
  formatAdminTimestamp,
  getArchiveFilenameForObserverUrl,
  isAdminRequesterAllowed,
  isValidAdminProcessName,
  normalizeRemoteAddress,
  resolvePm2ProcessNameFromSet,
  sanitizeArchiveFilenamePart,
} from "./admin";

function testNormalizeRemoteAddress(): void {
  assert.equal(normalizeRemoteAddress("::ffff:203.0.113.3"), "203.0.113.3");
  assert.equal(normalizeRemoteAddress("::1"), "::1");
  assert.equal(normalizeRemoteAddress("203.0.113.3"), "203.0.113.3");
}

function testAdminAllowlistIpLiterals(): void {
  const observerUrls = [
    "http://203.0.113.1:8101",
    "http://observer.example.com:8102",
    "http://[2001:db8::1]:8103",
  ];

  assert.deepEqual(isAdminRequesterAllowed("::ffff:203.0.113.1", observerUrls, true), {
    allowed: true,
    matchedObserverUrl: "http://203.0.113.1:8101",
    ignoredDnsHosts: [],
  });
  assert.equal(isAdminRequesterAllowed("observer.example.com", observerUrls, true).allowed, false);
  assert.equal(isAdminRequesterAllowed("2001:db8::1", observerUrls, true).allowed, true);
}

function testAdminAllowlistLocalhostMode(): void {
  assert.equal(isAdminRequesterAllowed("127.0.0.1", [], false).allowed, true);
  assert.equal(isAdminRequesterAllowed("::1", [], false).allowed, true);
  assert.equal(isAdminRequesterAllowed("127.0.0.1", [], true).allowed, false);
}

function testProcessNameValidation(): void {
  assert.equal(isValidAdminProcessName("observer"), true);
  assert.equal(isValidAdminProcessName("tss-party"), true);
  assert.equal(isValidAdminProcessName("pm2"), false);
  assert.equal(isValidAdminProcessName("observer-1"), false);
  assert.equal(isValidAdminProcessName("tss-party-99"), false);
  assert.equal(isValidAdminProcessName("tss-party-a"), false);
}

function testPm2NameResolutionFromSet(): void {
  assert.equal(resolvePm2ProcessNameFromSet("tss-party", 3, new Set(["tss-party"])), "tss-party");
  assert.equal(resolvePm2ProcessNameFromSet("tss-party", 3, new Set(["tss-party-3"])), "tss-party-3");
  assert.throws(() => resolvePm2ProcessNameFromSet("tss-party-4", 3, new Set(["tss-party-4"])), /Invalid/);
  assert.throws(() => resolvePm2ProcessNameFromSet("observer", 2, new Set(["tss-party-2"])), /not found/);
}

function testFilenameHelpers(): void {
  assert.equal(formatAdminTimestamp(new Date(2026, 4, 14, 18, 30, 0)), "2026-05-14-18-30-00");
  assert.equal(sanitizeArchiveFilenamePart("2001:db8::1"), "2001_db8__1");
  assert.equal(getArchiveFilenameForObserverUrl("http://203.0.113.3:8103"), "203.0.113.3-8103.tar.gz");
  assert.equal(getArchiveFilenameForObserverUrl("http://[2001:db8::1]:8103"), "2001_db8__1-8103.tar.gz");
}

function main(): void {
  testNormalizeRemoteAddress();
  testAdminAllowlistIpLiterals();
  testAdminAllowlistLocalhostMode();
  testProcessNameValidation();
  testPm2NameResolutionFromSet();
  testFilenameHelpers();
  console.log("observer admin tests passed");
}

main();
