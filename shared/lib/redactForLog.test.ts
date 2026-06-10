import assert from "node:assert/strict";
import { redactCommandArgsForLog, redactRpcUrlForLog } from "./redactForLog";

function testRedactRpcUrlCredentialsAndQuery(): void {
  const input = "https://user:pass@example.com/v3/my-api-key?Access_Token=abc123&foo=1";
  const redacted = redactRpcUrlForLog(input);
  const parsed = new URL(redacted);
  assert.equal(parsed.username, "***");
  assert.equal(parsed.password, "***");
  assert.equal(parsed.search, "?***");
  assert.equal(parsed.pathname, "/v3/***");
}

function testRedactRpcUrlPathBasedKeys(): void {
  const ankr = "https://rpc.ankr.com/bsc_testnet_chapel/SECRET_KEY";
  const ankrRedacted = redactRpcUrlForLog(ankr);
  assert.equal(new URL(ankrRedacted).pathname, "/bsc_testnet_chapel/***");

  const quicknode = "https://slug.quiknode.pro/SECRET_KEY";
  const quicknodeRedacted = redactRpcUrlForLog(quicknode);
  assert.equal(new URL(quicknodeRedacted).pathname, "/***");
}

function testRedactRpcUrlFallbackRegexParity(): void {
  const input = "/rpc?Auth=abc&access_token=def&token=ghi&other=value";
  const redacted = redactRpcUrlForLog(input);
  assert.equal(redacted, "/rpc?Auth=***&access_token=***&token=***&other=value");
}

function testRedactCommandArgsEqualsForm(): void {
  assert.equal(redactCommandArgsForLog(["--password=secret"]), "--password=***");
  assert.equal(redactCommandArgsForLog(["--Password=secret"]), "--password=***");
  assert.equal(redactCommandArgsForLog(["--channel_password=secret"]), "--channel_password=***");
}

function testRedactCommandArgsSeparateValueForm(): void {
  assert.equal(redactCommandArgsForLog(["--Password", "secret"]), "--Password ***");
  assert.equal(redactCommandArgsForLog(["--channel-password", "secret"]), "--channel-password ***");
}

function testRedactCommandArgsEdgeCases(): void {
  assert.equal(redactCommandArgsForLog([]), "");
  assert.equal(redactCommandArgsForLog(["--password"]), "--password");
  assert.equal(redactCommandArgsForLog(["--password", "--other"]), "--password --other");
  assert.equal(redactCommandArgsForLog(["--token", "abc"]), "--token abc");
}

function main(): void {
  testRedactRpcUrlCredentialsAndQuery();
  testRedactRpcUrlPathBasedKeys();
  testRedactRpcUrlFallbackRegexParity();
  testRedactCommandArgsEqualsForm();
  testRedactCommandArgsSeparateValueForm();
  testRedactCommandArgsEdgeCases();
  console.log("shared/lib/redactForLog.test.ts: ok");
}

main();
