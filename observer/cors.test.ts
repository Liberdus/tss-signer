import assert from "node:assert/strict";
import { isAllowedObserverCorsOrigin } from "./cors";

function testDefaultOrigins(): void {
  assert.equal(isAllowedObserverCorsOrigin("http://localhost:3000", []), true);
  assert.equal(isAllowedObserverCorsOrigin("http://127.0.0.1:8080", []), true);
  assert.equal(isAllowedObserverCorsOrigin("https://dev.liberdus.com", []), true);
  assert.equal(isAllowedObserverCorsOrigin("https://evil.example", []), false);
}

function testEnvOrigins(): void {
  assert.equal(isAllowedObserverCorsOrigin("https://bridge.example", ["https://bridge.example"]), true);
  assert.equal(
    isAllowedObserverCorsOrigin("https://staging.bridge.example", ["https://staging.bridge.*"]),
    true
  );
  assert.equal(isAllowedObserverCorsOrigin("https://bridge.example", ["https://other.example"]), false);
}

function main(): void {
  testDefaultOrigins();
  testEnvOrigins();
  console.log("observer/cors.test.ts: ok");
}

main();
