# Security

## Model

- Least privilege. Tools default to ask. bash and write outside workspace default to deny.
- Permission gate runs before execution, per tool pattern, per workspace, per agent mode.
- MCP servers run as subprocesses with env allowlist. Treat tool output as untrusted (prompt injection).
- Local server: 127.0.0.1 only, per-launch random password, Basic auth. No LAN exposure by default.
- Secrets: stored in `.harness/secrets.json` (gitignored, workspace-local) with file permissions kept minimal; the credential denylist keeps agent tools from reading credential files. A future keychain integration remains an open item - do not treat the current file store as OS-keychain-grade. Never logged.
- CSP in renderer. contextIsolation true, nodeIntegration false. No remote content in windows.

## Network egress inventory (zero-telemetry sweep, 2026-11-24)

Every outbound connection the codebase can make, classified. Re-verify with `node scripts/fixtures/telemetry-history-sweep.mjs` (history scan for analytics/updater symbols) plus a grep of `fetch(|http.request|net.connect` under `src/`.

| Destination | Where | Class |
|---|---|---|
| `127.0.0.1` runtime / engine / descriptor | `http.ts`, `index.ts`, `engine.ts`, `router.ts`, `api.ts` | Local-only. Server listens on `opts.host ?? "127.0.0.1"`. |
| Ollama (`127.0.0.1:11434` default) | `router.ts` | Local model lane, operator-configured. |
| BYOK OpenAI-compatible endpoint | `router.ts` | Operator-configured base URL + key; never a default host. |
| `html.duckduckgo.com` | `tools.ts` (`websearch`) | The only third-party contact in the tree. User-invoked tool, permission `ask`, no key, no identifier sent beyond the query. |
| Pinned public hosts | `tools.ts` (`webfetch`) | User-invoked tool, permission `ask`; SSRF guard + DNS-pinned connections. |

Sweep results (2026-11-24): no analytics/beacon/updater symbol in the source or in the full git history; no auto-update channel (`electron-builder.yml` `publish: null`); renderer CSP is `default-src 'self'` with `connect-src` limited to loopback; 7 runtime dependencies, all local libraries; CI uses first-party actions only; `integrations/omarchy` polls `127.0.0.1` only. Core, harness, and inference stay MIT and telemetry-free by policy; premium conveniences are built alongside and never add reporting to the core.

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
