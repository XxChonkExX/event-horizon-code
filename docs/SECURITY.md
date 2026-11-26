# Security

## Model

- Least privilege. Tools default to ask. bash and write outside workspace default to deny.
- Permission gate runs before execution, per tool pattern, per workspace, per agent mode.
- MCP servers run as subprocesses with env allowlist. Treat tool output as untrusted (prompt injection).
- Local server: 127.0.0.1 only, per-launch random password, Basic auth. No LAN exposure by default.
- Secrets (bring-your-own-key): `.harness/secrets.json`, gitignored, workspace-local. Saved from the desktop app, an `apiKey` is sealed with the OS keychain through Electron `safeStorage` (`enc1:` + base64; DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux) and is bound to the OS user account - copying the file to another machine or another user does not reveal the key. `baseUrl` stays readable by design. Where the OS keychain is unreachable - the headless runtime (`npm run serve`), or Linux without a keyring - a saved key is stored in plaintext and the panel says so (`PLAINTEXT`); the runtime also refuses to *use* a sealed key there and states why. Nothing is ever silently downgraded or faked: Linux "basic text" encryption (a hard-coded key) is deliberately not enabled. The BYOK lane pins its connections to the configured endpoint's resolved addresses - defense in depth (a same-user local process cannot relocate the key by poisoning DNS); the configured base URL remains the operator's authority and BYOK deliberately has no private-range block.
  - Verified: the built app seals a key, a fresh launch after a normal close decrypts it, and the agent lane sends the decrypted key to the configured endpoint; the Linux keyring proof is verified native on GNOME/Wayland (Strix, `gnome_libsecret` v11). macOS uses the same Electron API and is pending its own proof: `npm run secrets:test:electron` inside a graphical session is the proof to run on each platform.
  - What this does not establish: a process already running as the same OS user can use that user's keychain, so this protects stolen files and copied workspaces, not a compromised account. Not end-to-end encryption, not transport encryption, not database encryption (`docs/ENCRYPTION.md`).
  - Known edge, closed: on a brand-new profile the key that wraps sealed values is written ~10 s after the first launch, or at once on a normal close - not when a value is sealed. The first seal on such a profile now WAITS for that key before sealing (settle-before-seal), so a save is durable the moment it returns; measured against the built app (save waited 10.1 s, immediate force-kill, relaunch decrypts). If the wait cannot confirm within 30 s, the save proceeds and says the durability is unconfirmed. Details: `docs/ENCRYPTION.md`.
  - Plaintext backups (taken before existing keys are sealed, also offered by the panel) live in `~/.eventhorizon/backups/<timestamp>/secrets.json` - outside every workspace, so agent file tools cannot reach them, and the shell credential rule refuses the filename. They are listed in the panel and deletable there once moved somewhere safe; they are plaintext by design and the panel says so.
  - The file is written owner-only (`0600`) where the OS supports it; on Windows it inherits the workspace folder's ACL. The status API never returns a key value, the audit log records provider names and storage state only, and the credential denylist still keeps agent tools from reading the file.
- CSP in renderer. contextIsolation true, nodeIntegration false. No remote content in windows.
- **Permissions (microphone, camera, clipboard, …).** Electron *grants* permission requests by default. EHC keeps that for windows it opened itself, scoped twice: the **microphone** to its own windows (speech-to-text), and the **camera** to the camera window alone (`src/main/index.ts`, `session.setPermissionCheckHandler` / `setPermissionRequestHandler`; membership is decided by window identity, not by URL). A webContents that is not one of ours, or a sub-frame, gets nothing. Do not replace these handlers with a deny-by-default list: that is exactly how 0.0.3e's last build lost clipboard copy and terminal paste.
  - **Camera frames** (`src/server/sensors.ts`): a frame goes to the engine on this machine by default. Sending one to a BYOK provider requires `allowRemote: true` in the request - the UI's consent lives only in the camera window's session and is never saved - and the server refuses with 403 before any request otherwise. Only providers with a key are listed, the lane list never carries a key, frames are validated (JPEG/PNG/WebP data URL, 2 MB cap; SVG refused) and never written to disk, and each look is audited by lane and byte count. `npm run sensors:test` covers the gate against a loopback stub.
  - Verified in the running app: clipboard read/write and notifications `granted`, microphone `granted`, `getUserMedia({video})` refused with `NotAllowedError`, and with no handlers at all every one of them is granted (which is why the default is kept rather than re-invented).
  - The **check** stage applies the same rule since `main` after 0.0.4a: only our own main frame is granted anything. The 0.0.4a artifacts still grant non-media permissions at the check stage to any webContents; that cannot be reached there because the renderer's CSP forbids remote frames and navigation is blocked, but it is the first thing to close before any embedded web content exists (`docs/BROWSER.md`, step S4.0).

## Network egress inventory (zero-telemetry sweep, 2026-11-24; extended 2026-11-25 for optional downloads)

Every outbound connection the codebase can make, classified. Re-verify with `node scripts/fixtures/telemetry-history-sweep.mjs` (history scan for analytics/updater symbols) plus a grep of `fetch(|http.request|net.connect` under `src/`.

| Destination | Where | Class |
|---|---|---|
| `127.0.0.1` runtime / engine / descriptor | `http.ts`, `index.ts`, `engine.ts`, `router.ts`, `api.ts` | Local-only. Server listens on `opts.host ?? "127.0.0.1"`. |
| Ollama (`127.0.0.1:11434` default) | `router.ts` | Local model lane, operator-configured. |
| BYOK OpenAI-compatible endpoint | `router.ts` | Operator-configured base URL + key; never a default host. |
| - | `secrets.ts` | Makes no network call. A key leaves the machine only toward the BYOK base URL above. |
| `html.duckduckgo.com` | `tools.ts` (`websearch`) | User-invoked tool, permission `ask`, no key, no identifier sent beyond the query. |
| Pinned public hosts | `tools.ts` (`webfetch`) | User-invoked tool, permission `ask`; SSRF guard + DNS-pinned connections. |
| `github.com`, `huggingface.co` (+ `*.githubusercontent.com`, `*.hf.co` on redirect) | `sensoryfetch.ts` | **User-clicked only**: a download button in the Sensory panel. Fixed catalog (`sensory-catalog.ts`), address checked against the allowlist before the request and on every hop, exact-size cap, SHA-256 verified against the value the source publishes, one job at a time, cancellable. A plain GET with the User-Agent `event-horizon-code`; nothing else is sent. |
| Official project sites | `main/index.ts` (`shell:openExternal`) | **User-clicked only**: an install link in the Toolchain Doctor or a project link in the Sensory panel. The URL must be https and on the allowlist in `shared/externals.ts`, and the IPC sender must be a trusted renderer. It opens in the user's own browser. |

The allowlist (`src/shared/externals.ts`) is the single source for both rows above and is covered by `npm run sensoryfetch:test`, including "a non-listed host is refused before any connection is made".

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
- Optional downloads follow the same rule by construction: nothing is fetched unless it is a row of the pinned catalog, the user clicked it, and the bytes match the SHA-256 the source publishes. Archive extraction is flat and name-checked (path traversal entries are refused, never sanitised - `src/server/unzip.ts`), and only `whisper-cli(.exe)`, `whisper.dll` and `ggml*.dll` are kept from the engine archive. Model weights keep the licence of their source (whisper.cpp's ggml conversions, MIT) and are never bundled with the app.
