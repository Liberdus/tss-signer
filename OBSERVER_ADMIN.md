# Observer Admin Operations

The observer exposes admin-only tooling for collecting logs, restarting PM2 processes, and temporarily updating software across observer machines.

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
- `tss-party`

Names resolve on the receiving machine. For example, `tss-party` resolves to `tss-party` if present in PM2, otherwise `tss-party-${PARTY_INDEX}`.

Successful requests return:

```json
{ "Ok": "restart_scheduled", "requestedName": "tss-party", "resolvedName": "tss-party-1" }
```

This means the restart was accepted and scheduled. The actual PM2 command result is logged by the target observer after the response is sent.

## Operator Admin CLI

Run the CLI from an observer machine so the source IP is allowed by the admin endpoints:

```bash
npm run operator-admin
```

The CLI prompts for:

- action: `collect-logs`, `restart`, or `update-software`
- target: `all` or one observer URL from `observer-list.json`
- PM2 process name for restart: `observer` or `tss-party`

Non-interactive example:

```bash
npm run operator-admin -- --action collect-logs --target all --yes
```

Restart example:

```bash
npm run operator-admin -- --action restart --target http://203.0.113.3:8103 --name tss-party --yes
```

The explicit target must match a normalized URL in `observer-list.json`.

Software update example:

```bash
npm run operator-admin -- --action update-software --target all --yes
```

This calls `POST /admin/software/update` on the selected observers. The endpoint runs only this fixed sequence from the project root:

```text
git status --porcelain --untracked-files=no
git rev-parse HEAD
git fetch origin main
git merge --ff-only origin/main
git rev-parse HEAD
npm run compile
```

The endpoint can be enabled or disabled with `SOFTWARE_UPDATE_ENABLED` at the top of `observer/admin.ts`. Keep it disabled in production unless a controlled maintenance update is needed. The current default update target is `origin/main`, configured there with `SOFTWARE_UPDATE_REMOTE` and `SOFTWARE_UPDATE_BRANCH`.

If tracked files are modified or staged, the update is rejected before fetching or merging. Untracked files are ignored by this preflight. The update endpoint does not run `npm install` and does not restart PM2; run the restart action separately after a successful update.

## Collected Logs Output

Output:

```text
collected-logs/YYYY-MM-DD-HH-mm-ss/
  203.0.113.1-8101.tar.gz
  203.0.113.2-8102.tar.gz
  manifest.json
```

`manifest.json` records each target URL, archive filename, status, `sizeKb`, duration, and error if any.

## Restart Output

Output:

```text
admin-results/restart-YYYY-MM-DD-HH-mm-ss.json
```

The manifest records requested target, requested name, resolved process name, status, duration, and error if any. Restart status `scheduled` means the target endpoint accepted the restart request; it does not mean PM2 has already completed the restart.

## Software Update Output

Output:

```text
admin-results/update-YYYY-MM-DD-HH-mm-ss.json
```

The manifest records each target URL, status, before/after commit, whether code changed, compile result, duration, and capped output snippets.

## Timeouts And Logs

- Local archive creation timeout: 5 minutes.
- CLI log download timeout: 5 minutes.
- PM2 restart command timeout: 10 seconds.
- Software update command timeout: 5 minutes per fixed command.
- Admin endpoint attempts are logged with requester IP, normalized IP, allow/deny result, route, and outcome.
- Log values are sanitized to avoid control-character log injection.
