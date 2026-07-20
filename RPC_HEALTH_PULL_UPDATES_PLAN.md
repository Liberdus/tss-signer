# Pull-Based TSS Health Reporting

## Summary

Create `rpc-health-pull-updates` branches from `dev` in the TSS signer, status server, and Discord bot repositories. Replace push-based alerting with observer-owned health endpoints polled by status-server every 24 hours. Status-server relays only health failures, polling errors, unchanged provider reports, and failed-provider results; the Discord bot formats and delivers notifications.

## TSS signer

- Only the observer exposes HTTP; `tss-party` does not open another port.
- Each `tss-party` atomically refreshes a party-specific heartbeat JSON every 15 seconds.
- The observer treats a heartbeat as unhealthy after 45 seconds.
- `GET /health` reports combined observer and paired TSS-party health, returning HTTP 200 only when both are healthy and HTTP 503 otherwise.
- Provider checks continue every 24 hours and atomically replace `provider-health.json` after each completed check.
- `GET /provider-health` returns only `checkedAt`, `failedProviderCount`, and provider names with chain metadata.
- Healthy checks write a fresh timestamp with zero failures.
- Incomplete checks leave the previous provider report unchanged so status-server can detect a stale timestamp.
- RPC URLs, API keys, headers, host addresses, and raw provider errors must never appear in report JSON or HTTP responses.

## Status server

- Keep observer IDs, labels, networks, and base URLs configured in status-server.
- Poll `/health` and `/provider-health` at startup and every 24 hours.
- Use three attempts per request with a 10-second timeout, logging every failed attempt.
- Relay health errors only after all attempts fail or the observer remains unhealthy.
- For provider health:
  - unchanged `checkedAt` produces a file-not-updated error;
  - a changed timestamp with failures relays the provider JSON;
  - a changed timestamp with no failures produces no alert.
- Keep status-server logic limited to polling, timestamp comparison, count validation, and relaying.
- Expose the latest shareable results through `GET /api/tss-health`, distinguishing health errors, provider-health errors, and provider results.

## Discord bot

- Poll `GET /api/tss-health` through the existing status-server connection.
- Route results by the status-server-owned signer network.
- Post health errors, unchanged-file errors, and non-empty failed-provider results.
- Persist the last processed result identity so repeated polls do not repost results.
- Split messages at Discord’s 2,000-character limit.
- Mark delivery successful only after every split message is sent.

## Verification plan

- Test combined observer/TSS-party health, heartbeat expiry, and HTTP status codes.
- Test provider report replacement after healthy and unhealthy checks.
- Verify `failedProviderCount` always equals the failed-provider array length.
- Test unchanged timestamps, empty and non-empty failure lists, retries, and unreachable observers.
- Use secret canaries to confirm URLs and credentials never enter files, responses, logs, status results, or Discord messages.
- Test bot routing, duplicate suppression, message splitting, and partial delivery failures.
- Run TypeScript compilation and focused tests in all three clean `dev`-based worktrees.

## Assumptions

- Both status-server polling jobs run every 24 hours with no freshness grace period.
- Signer endpoints rely on deployment network controls rather than application authentication.
- Healthy polls and recoveries do not generate Discord messages.
- Existing dirty trees and untracked credential files remain untouched.
