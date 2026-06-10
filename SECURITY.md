# Security Policy

**Liberdus Bridge TSS Server** (`tss-signer`, npm package `tss-server`)

## Supported Versions

Security fixes are applied to the **default branch** (`main`) and released versions as tagged in this repository.

| Version   | Supported | Notes                          |
| --------- | --------- | ------------------------------ |
| `1.0.8`   | Yes       | Current release (`package.json`) |
| `1.0.x`   | Yes       | Other `1.0` tags when applicable |
| `< 1.0.0` | No        |                                |

Older commits or forks deployed without tracking `main` may not receive patches.

## Reporting a Vulnerability or Security Concern

If you discover a security vulnerability in **Liberdus Bridge TSS Server** / **tss-signer** (observer, TSS party tooling, bridge gossip endpoints, admin API, etc.), please report it privately so we can investigate before details are public.

**Do not** create a public GitHub issue for exploitable vulnerabilities, and do not paste production credentials, private keys, channel passwords, or full RPC URLs with API keys into public channels.

### Preferred: private disclosure

Use GitHub **Private vulnerability reporting** on the [Security tab](https://github.com/Liberdus/tss-signer/security) (**Report a vulnerability**). This is the preferred path for sensitive reports.

Include as much of the following as you can:

- Description of the vulnerability and potential impact
- Steps to reproduce (or proof-of-concept), if applicable
- Affected component (e.g. `observer/`, `tss-tools/`, `shared/lib/`)
- Version or commit SHA (or branch) you tested against
- Any logs or screenshots (redact secrets, API keys, passwords, and private URLs)

If private reporting is unavailable, email maintainers through the contact listed on the repository or organization profile and ask for a secure channel.

### Public issues (non-sensitive only)

For **non-sensitive hardening suggestions** or general security improvements that are not exploitable vulnerabilities, you may [open a GitHub issue](https://github.com/Liberdus/tss-signer/issues/new) with a clear title, e.g. `Security: <short summary>`.

## What to Expect

- **Acknowledgement:** We aim to respond within a few business days.
- **Triage:** We will confirm whether the report is a vulnerability, a hardening request, or expected behavior.
- **Updates:** We will post status updates on the issue (or private advisory) as we investigate.
- **Fix:** Confirmed issues are prioritized by severity; fixes typically land on `main` first, then in a tagged release when appropriate.
- **Credit:** We are happy to credit reporters in release notes when they agree.

## Out of Scope

The following are generally **not** treated as vulnerabilities in this repo:

- Issues in vendored or cached dependencies under `tss/.tooling/` (report upstream or open a separate dependency bump issue)
- Denial-of-service against public HTTP endpoints without a practical impact on bridge safety or key material (we still welcome hardening suggestions via issues)
- Misconfiguration on deployed servers (firewall, exposed ports, weak PM2 permissions) without a corresponding code defect

Thank you for helping keep Liberdus TSS infrastructure secure.
