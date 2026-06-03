import assert from "node:assert/strict";
import { resolveBridgeInRateLimitPerMin } from "./bridgeInRateLimit";

function testValidRateLimit(): void {
  const config = resolveBridgeInRateLimitPerMin("500");
  assert.equal(config.limit, 500);
  assert.equal(config.isValid, true);
}

function testInvalidRateLimitDefaults(): void {
  assert.equal(resolveBridgeInRateLimitPerMin(undefined).limit, 120);
  assert.equal(resolveBridgeInRateLimitPerMin("120abc").limit, 120);
  assert.equal(resolveBridgeInRateLimitPerMin("0").limit, 120);
  assert.equal(resolveBridgeInRateLimitPerMin("-1").limit, 120);
}

function testUpperBoundEnforced(): void {
  const tooLarge = resolveBridgeInRateLimitPerMin("10001");
  assert.equal(tooLarge.limit, 120);
  assert.equal(tooLarge.isValid, false);
}

function main(): void {
  testValidRateLimit();
  testInvalidRateLimitDefaults();
  testUpperBoundEnforced();
  console.log("observer/bridgeInRateLimit.test.ts: ok");
}

main();
