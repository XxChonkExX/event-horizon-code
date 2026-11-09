# Security

## Model

- Least privilege. Tools default to ask. bash and write outside workspace default to deny.
- Permission gate runs before execution, per tool pattern, per workspace, per agent mode.
- MCP servers run as subprocesses with env allowlist. Treat tool output as untrusted (prompt injection).
- Local server: 127.0.0.1 only, per-launch random password, Basic auth. No LAN exposure by default.
- Secrets: OS keychain preferred, encrypted file fallback. Never logged.
- CSP in renderer. contextIsolation true, nodeIntegration false. No remote content in windows.

## Build

- Reproducible, pinned lockfile, SBOM in CI.
- Code signing: macOS notarized DMG, Windows signed EXE/MSI, Linux signed AppImage/deb/rpm.
- No auto-update phone-home. Manual check only.
- No Sentry, no PostHog, no analytics.

## Audit

- ~/.eventhorizon/audit.jsonl: timestamp, session, agent, tool, args hash, result, model, cost.
- Git snapshots per session for revert.

## Supply chain

- Only load Agent Skills from trusted local folders (skills/, .harness/skills/, project .ehc/skills).
- Engram packs are checksummed (SHA256). User-pinned files only. No runtime web fetching into context.
