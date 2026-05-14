# Observer Admin Operations

The observer exposes admin-only tooling for collecting logs and restarting PM2 processes across observer machines.

## Access Rules

- Admin routes are under `/admin`.
- Requests are allowed only from IP-literal hosts listed in `observer-list.json`.
- DNS hostnames in `observer-list.json` are ignored for admin source-IP allowlisting.
- `X-Forwarded-For` is logged for context but is not trusted for authorization.
- When `chain-config.json` has `isRemote: false`, localhost is also allowed for local development.
- When `isRemote: true`, localhost is not implicitly allowed.
- `observer-list.json` is loaded once at observer startup. Runtime changes require an observer restart.

## Startup Requirements

In remote mode, the observer must identify its own observer URL and that URL must be present in `observer-list.json`.

Self URL resolution uses:

- `TSS_SELF_OBSERVER_URL`, if set
- otherwise public-IP matching against `observer-list.json`

For local non-remote development, an empty or missing `observer-list.json` is allowed.

## Download Local Logs

```bash
curl -O -J http://<observer-ip>:<observer-port>/admin/logs/archive
```

The response is a streamed `.tar.gz` of the local `logs/` directory. The observer uses system `tar` and does not buffer the full archive in memory.

## Restart Local PM2 Process

```bash
curl -X POST http://<observer-ip>:<observer-port>/admin/pm2/restart \
  -H 'Content-Type: application/json' \
  -d '{"name":"tss-party"}'
```

Allowed names:

- `observer`
- `observer-N`
- `tss-party`
- `tss-party-N`

Generic names resolve on the receiving machine. For example, `tss-party` resolves to `tss-party` if present in PM2, otherwise `tss-party-${PARTY_INDEX}`.

Successful requests return:

```json
{ "Ok": "restart_scheduled", "requestedName": "tss-party", "resolvedName": "tss-party-1" }
```

## Signal-Based Operations

The observer handles `SIGUSR2` by reading:

```text
<project-root>/admin-signal.json
```

Write the file atomically:

```bash
cat > admin-signal.tmp.json <<'JSON'
{ "action": "collect-logs", "target": "all" }
JSON
mv admin-signal.tmp.json admin-signal.json
kill -USR2 <observer-pid>
```

On success, `admin-signal.json` is left in place. A later `SIGUSR2` will process the same file again unless the operator changes or removes it.

On parse or validation failure, the file is left in place for inspection and correction.

## Collect Logs By Signal

Collect from every observer in `observer-list.json`:

```json
{ "action": "collect-logs", "target": "all" }
```

Collect from one explicit observer:

```json
{ "action": "collect-logs", "target": "http://203.0.113.3:8103" }
```

The explicit target must exactly match a normalized URL in `observer-list.json`.

Output:

```text
collected-logs/YYYY-MM-DD-HH-mm-ss-SSS/
  203.0.113.1-8101.tar.gz
  203.0.113.2-8102.tar.gz
  manifest.json
```

`manifest.json` records each target URL, archive filename, status, size, duration, and error if any.

## Restart By Signal

Restart on every observer in `observer-list.json`:

```json
{ "action": "restart", "target": "all", "name": "tss-party" }
```

Restart one explicit observer:

```json
{ "action": "restart", "target": "http://203.0.113.3:8103", "name": "tss-party-3" }
```

For `target: "all"`, peer restart requests are sent first. If the local observer is also a target, its restart is deferred until after the restart manifest is written.

Output:

```text
admin-results/restart-YYYY-MM-DD-HH-mm-ss-SSS.json
```

The manifest records requested target, requested name, resolved process name, status, duration, and error if any.

## Timeouts And Logs

- Local archive creation timeout: 5 minutes.
- Peer log download timeout: 5 minutes.
- PM2 restart command timeout: 10 seconds.
- Admin endpoint attempts are logged with requester IP, normalized IP, allow/deny result, route, and outcome.
- Log values are sanitized to avoid control-character log injection.
