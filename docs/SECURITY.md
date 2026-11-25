# Security

## Model

- Least privilege. Tools default to ask. bash and write outside workspace default to deny.
- Permission gate runs before execution, per tool pattern, per workspace, per agent mode.
- MCP servers run as subprocesses with env allowlist. Treat tool output as untrusted (prompt injection).
- Local server: 127.0.0.1 only, per-launch random password, Basic auth. No LAN exposure by default.
- Secrets (bring-your-own-key): `.harness/secrets.json`, gitignored, workspace-local. Saved from the desktop app, an `apiKey` is sealed with the OS keychain through Electron `safeStorage` (`enc1:` + base64; DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux) and is bound to the OS user account - copying the file to another machine or another user does not reveal the key. `baseUrl` stays readable by design. Where the OS keychain is unreachable - the headless runtime (`npm run serve`), or Linux without a keyring - a saved key is stored in plaintext and the panel says so (`PLAINTEXT`); the runtime also refuses to *use* a sealed key there and states why. Nothing is ever silently downgraded or faked: Linux "basic text" encryption (a hard-coded key) is deliberately not enabled.
  - Verified end to end on Windows only: the built app seals a key, a fresh launch after a normal close decrypts it, and the agent lane sends the decrypted key to the configured endpoint. Linux and macOS use the same Electron API but are **untested here** - `npm run secrets:test:electron` inside a graphical session is the proof to run on each.
  - What this does not establish: a process already running as the same OS user can use that user's keychain, so this protects stolen files and copied workspaces, not a compromised account. Not end-to-end encryption, not transport encryption, not database encryption (`docs/ENCRYPTION.md`).
  - Known edge, closed: on a brand-new profile the key that wraps sealed values is written ~10 s after the first launch, or at once on a normal close - not when a value is sealed. The first seal on such a profile now WAITS for that key before sealing (settle-before-seal), so a save is durable the moment it returns; measured against the built app (save waited 10.1 s, immediate force-kill, relaunch decrypts). If the wait cannot confirm within 30 s, the save proceeds and says the durability is unconfirmed. Details: `docs/ENCRYPTION.md`.
  - Plaintext backups (taken before existing keys are sealed, also offered by the panel) live in `~/.eventhorizon/backups/<timestamp>/secrets.json` - outside every workspace, so agent file tools cannot reach them, and the shell credential rule refuses the filename. They are listed in the panel and deletable there once moved somewhere safe; they are plaintext by design and the panel says so.
  - The file is written owner-only (`0600`) where the OS supports it; on Windows it inherits the workspace folder's ACL. The status API never returns a key value, the audit log records provider names and storage state only, and the credential denylist still keeps agent tools from reading the file.
- CSP in renderer. contextIsolation true, nodeIntegration false. No remote content in windows.

## Network egress inventory (zero-telemetry sweep, 2026-11-24)

Every outbound connection the codebase can make, classified. Re-verify with `node scripts/fixtures/telemetry-history-sweep.mjs` (history scan for analytics/updater symbols) plus a grep of `fetch(|http.request|net.connect` under `src/`.

| Destination | Where | Class |
|---|---|---|
| `127.0.0.1` runtime / engine / descriptor | `http.ts`, `index.ts`, `engine.ts`, `router.ts`, `api.ts` | Local-only. Server listens on `opts.host ?? "127.0.0.1"`. |
| Ollama (`127.0.0.1:11434` default) | `router.ts` | Local model lane, operator-configured. |
| BYOK OpenAI-compatible endpoint | `router.ts` | Operator-configured base URL + key; never a default host. |
| - | `secrets.ts` | Makes no network call. A key leaves the machine only toward the BYOK base URL above. |
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
