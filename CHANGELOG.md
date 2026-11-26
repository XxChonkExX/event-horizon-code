# Changelog

All notable changes to Event Horizon Code. Newest first.
Format: Keep a Changelog; semver. Negative results are recorded, not hidden.

## [Unreleased]

- Nothing yet.

## [0.0.4a] - 2026-11-25 - speech-to-text, optional downloads, UI/UX sweep

**Policy change (operator decision): zero telemetry, zero cloud, downloads only when you click.** Nothing is ever fetched, installed or reported on its own; the app is fully usable offline. What is new is that the user can *choose* to download a sidecar or language model from its official source, and gets an official link for anything else.

### Added

- **Speech-to-text works in the composer.** A microphone button: press to record, press again to transcribe with whisper.cpp on your own machine. While recording the button stays pressable and shows a live level meter, a clock and a discard button; recording stops by itself at 60 s. The transcript is inserted into the composer for review - it is never auto-sent. A picker chooses between several inputs and the choice is remembered.
  - Verified end to end in the real app with a synthetic speech source through the real button, recorder, WAV conversion, server route and whisper.cpp: 13 s of speech transcribed in 2.3 s with no log lines in the text. Real microphones (4 inputs on the test machine) open, meter and release on every path (stop, discard, component teardown).
- **Optional downloads in the Sensory panel** (`src/server/sensoryfetch.ts`): the whisper.cpp engine for Windows x64 and ARM64, and eight language models (English-only and multilingual, 75 MB to 1.5 GB). Each row is pinned - official URL, exact size, the SHA-256 published by the source - and a file that does not match is deleted, never installed. One download at a time, progress, cancel, 60 s stall timeout. Only `github.com` and `huggingface.co` (and their download CDNs on redirect) are ever contacted, and only after a click. The catalog is generated from the sources' own metadata (`scripts/generate-sensory-catalog.mjs`); all ten pinned files were re-downloaded and matched before release.
  - Verified in the real app, from the panel's own buttons: engine from github.com (1.3 s), model from huggingface.co with a matching on-disk SHA-256, a 1.4 GB download cancelled mid-flight leaving no file or `.part`, and installed items refusing to download again.
- **Every missing tool in the Toolchain Doctor has an `install` link** to its official page - 66 commands across the 31 language packs (Rust, Clang, GCC, Ruby, Node, Python, Go, Java, Docker, …), with Windows footnotes where "install it" has a second half (Rust needs the MSVC Build Tools, bash comes with Git for Windows). Links open in your own browser and are checked against an allowlist (`src/shared/externals.ts`) in the main process first. Nothing is bundled or installed by the app.
- **Spoken language and model choice** in the Sensory panel: 89 languages plus "detect automatically"; a model installed by hand can be picked with **use**. Preferences stay on the machine.
- `ehc:want-panel` window event: a component can ask the workbench to open a panel by id (the mic button uses it to take you straight to speech setup).
- Tests: `npm run sensoryfetch:test` (new, ~60 checks, fully offline: allowlist, ZIP reader, download loop against a loopback stub, verify-then-install with injected bytes). `npm run sensory:test` now exercises the real path when whisper.cpp is installed and transcribes a real sample when `EH_STT_SAMPLE=<speech.wav>` is set.

### Fixed

- **The editor and the terminal were missing at launch** since in-place session switching landed (2026-11-18). `sessionVersion` started at `0`, which a `Show` treats as off, and only a session *switch* bumped it - so on the boot session files opened as tabs with no editor behind them, and no shell existed, until you switched sessions. It now starts at 1. Verified: Monaco and the PTY are present on the first paint.
- **Clipboard copy and terminal paste were broken in the last 0.0.3e build** (`b05fcc0`, published 2026-11-25). The Electron permission handlers added for the microphone denied everything except media, which refused `navigator.clipboard.writeText` / `readText`. Correcting the record: that commit's stated root cause was wrong. Electron **grants** permission requests by default (measured with no handlers: microphone, camera, clipboard and notifications all `granted`), so the app never denied the mic, and the "fix" only removed permissions. The policy now: our own windows keep the default, the camera is never granted, a window we did not open gets nothing. Verified in the real app: clipboard read/write and notifications `granted`, microphone `granted`, camera `getUserMedia` refused with `NotAllowedError`.
- The mic button could never stop a recording: it was disabled while recording and the second press returned early.
- `transcribe()` appended whisper.cpp's stderr log lines (`read_audio_data: …`) to the transcript. It reads stdout only, validates that the input is a WAV, caps its length, and reports the real exit status on failure.
- Speech detection knew three model file names; it now finds any `ggml-*.bin` and `whisper-cli` on `PATH` (package-manager installs), and picks the best installed model, preferring the English-only one when English is selected.
- **Composer overflowed the chat column** on a 1280×720 logical display: the Send button sat 101 px off-screen and the mic picker expanded to its longest option.
- The panel tab strip could be crushed to a 22 px clipped band when the editor took its floor.
- The Sensory panel kept showing "installed" after files were removed by hand; it now re-checks when asked for and when the window regains focus.

### Changed - UI/UX sweep (measured at 1268×638 CSS px, a 4K display at 300 %)

- Composer: the input owns its line and is three lines tall; mic, picker and Send sit on their own row. The token budget, auto-approve and speech controls fold under **options**; the states that change what the agent may do stay visible as flags on the model row (**auto-approve**, **speaking**). The message list grew from 143 px to 243 px.
- Panel tabs: no visible scrollbar, a vertical wheel scrolls the strip, and the active tab is scrolled into view.
- One dark scrollbar style throughout (the message list and code blocks showed white tracks).
- Microphone labels shortened ("Default · Microphone (Logitech PRO X Gaming Headset)").
- Chat column overflow is 0; nothing in it extends past the window edge.

### Docs

README, PRIVACY, SECURITY (egress inventory extended with the download and link paths, and the camera/microphone policy), SENSORY, RELEASE, NOTICE, AGENTS.md (download policy, test stages) and UIUX-AUDIT brought up to date. PRIVACY previously placed the CSP in the main process (it is a meta tag) and described the detonation lane as a microVM (it is WSL2 namespaces / bubblewrap / Seatbelt; the microVM is optional).

### Known issues

- Linux and macOS: no in-app engine download yet (the Linux asset is a tar.gz; macOS ships none). Install whisper.cpp with a package manager or build it - it is found on `PATH` - and models still download from the panel. Linux AppImage/deb were last packaged and verified at 0.0.3d; **this release publishes Windows installers only**.
- The macOS keyring proof is still pending.
- A real voice through a real microphone was not machine-tested (no speech source at the agent's end): capture, metering, release and the full transcription path are verified separately; say the word if anything feels off.
- The 0.0.3e assets on GitHub are the `b05fcc0` build and contain the clipboard regression above; 0.0.4a supersedes them.

## 0.0.3e re-publish (2026-11-25, later builds)

The 0.0.3e assets were replaced during 2026-11-25 without a new tag. Recorded here because the builds were published:

- **Fixed: the BYOK key test's probe shape was pathological for thinking models.** Measured on NIM's glm-5.3-flash: a `max_tokens=1` probe took **84 s** (the single token spent on reasoning, empty content) and blew the test's 30 s cap, while a real agent budget (1024) finished in 23.8 s - the model's per-request latency dominates, not token count. The test now sends a 128-token budget with a 120 s timeout, so "test" measures the KEY (it reports the real round-trip latency). Also recorded: NIM's `/models` catalog is account-scoped - a listed model can still 404 for chat on the account.
- **Fixed: the DNS pin broke the BYOK lane on Node/Electron with autoSelectFamily** (found by the operator's own key tests: every provider test failed `endpoint unreachable: fetch failed` in the new install). Node's happy-eyeballs lookup path (`options.all === true`) consumes the ARRAY callback form; the pin served the single-address form -> `ERR_INVALID_IP_ADDRESS` on every pinned fetch. `dnspin.pinnedAgent` now serves both contracts (proven against the real openrouter.ai endpoint from plain node, and netpin:test on loopback). webfetch shared the same latent bug via the extracted helper - fixed together.
- **BYOK model catalog probe**: `GET /api/secrets/:provider/models` fetches the provider's own `/models` (pinned connection, operator base URL only, model ids are public catalog data). The Models panel gains a **models** button per provider: the endpoint's catalog appears as a list; clicking a model sets it as that provider's model. Smoke-covered offline via a local stub.

- **Panels fill the window** and the composer gained a **BYOK quick-switch** listing the selected provider's own model catalog.
- **Composer microphone button** posting to `/api/sensory/transcribe` (speech-to-text needed a sidecar and could not stop a recording - see 0.0.4a).
- Electron session permission handlers were added for the microphone. **The final re-published build (`b05fcc0`) broke clipboard copy and terminal paste** by denying every other permission; fixed in 0.0.4a.

## [0.0.3e] - 2026-11-25

- **BYOK keys are sealed with the OS keychain** (Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). New `src/server/secrets.ts`, `/api/secrets*`, and a BYOK section in the Models panel: save a key, see how each stored key is kept, seal existing plaintext values in place, two-step remove. Where no keychain is reachable (the headless runtime, Linux without a keyring) a saved key stays plaintext and the panel says so in warning colour - never a silent downgrade, and a sealed key is refused with the reason rather than guessed at. Keys are never returned by the status API, never shown after saving, never logged.
  - Verified end to end on Windows: the built app seals a key, a fresh launch decrypts it, the agent lane sends the decrypted key to the configured endpoint; the same file handed to a headless runtime is refused with nothing sent. The module's POSIX behaviour is verified on Linux (WSL2, `0600` file / `0700` backup folder); the Linux keyring proof is verified native on GNOME/Wayland (Strix, `gnome_libsecret` v11); the macOS keyring proof is pending its own machine.
  - First-launch window closed: on a brand-new profile Chromium writes its wrapping key ~10 s after launch, so the first seal now WAITS for it (settle-before-seal). Measured against the built app: the save waited 10.1 s, the app was force-killed immediately, and the relaunch decrypted the key. (An envelope design was considered and rejected: a data key wrapped by `safeStorage` depends on the same unwritten key and would not have helped.)
- **Stored BYOK providers are selectable in the composer**: a provider saved with base URL + key + model appears in the model picker (and profiles) as `byok:<provider>` and routes turns through that endpoint. A missing or unreadable key there is a stated failure, never a silent reroute. The panel shows each provider's endpoint and model, and **test** fires one 1-token completion through the same call the agent makes.
- **Plaintext backups before sealing**: "Encrypt stored keys" is gated behind a backup the panel saves to `~/.eventhorizon/backups/<timestamp>/secrets.json` (outside every workspace; agent tools cannot reach it; deletable in the panel once moved somewhere safe). A deliberate two-click bypass exists and says "NO backup was taken" in its verdict.
- **Credential denylist covers a relocated secrets file.** `EH_SECRETS_FILE` can place the file under any name, which the name-based rules did not know. `safePath` now compares the resolved path and the shell rule refuses the configured name. An empty `EH_SECRETS_FILE` means "not set".
- **BYOK lane pins its connections (DNS defense in depth).** `chatOpenAI` now resolves the configured endpoint's addresses once per call and connects only to them (shared `src/server/dnspin.ts`, also used by webfetch). The operator's `baseUrl` remains the authority (BYOK has no private-range block - llama-server/LM Studio/vLLIP LAN endpoints stay supported); the pin means DNS cannot relocate the key mid-session. A DNS failure is an honest `endpoint unreachable: dns: ...`. `netpin:test` covers loopback, an unreachable endpoint, and dead-name resolution.
- **MCP env secret references.** MCP server configs (`env`, command, args) may write `"GITHUB_TOKEN": "${secrets:github}"` - resolved through the BYOK keychain when the server starts; tokens live sealed, never in `config.json` or a log; a missing/unreadable reference fails the start with the reason; the audit records referenced provider names only. `mcpsecrets:test`.
- **Usage rollup:** `usageSummary` now reports per-model call counts; the Runs panel footer shows total tokens and turns by model.
- Tests: `secrets:test` (plain node, ~90 checks - also run on Linux/WSL2), `secrets:test:electron` (real keychain: two launches plus a fresh-profile crash scenario, four Electron processes), `/api/secrets` and the BYOK picker/lane in the end-to-end smoke, relocated-file cases in `wsguard:test` and `detonate:test`.
- Docs: SECURITY.md, PRIVACY.md and ENCRYPTION.md now state exactly what is built and what was verified. PRIVACY.md previously claimed an "encrypted file fallback" that did not exist. Closes audit item 17.

## [0.0.3d] - 2026-11-23 - Linux packaging + Omarchy

- Linux **AppImage and deb packaged and verified live** on Omarchy/Arch (author email added for the deb maintainer field).
- An **Omarchy shell plugin** ships in `integrations/omarchy/` (sessions-bar widget + panel).
- README refresh: detonation lane documented with its per-platform sandbox.

## [0.0.3c] - 2026-11-22 - follow-up audit hardening (assurance truthfulness)

Remediation of the 0.0.3b follow-up audit (P0 security correctness + P1 containment):

- **Seatbelt tree lifecycle is truthful**: the macOS runner no longer asserts `treeTerminated: true` without verification - the child spawns detached (own process group, group-kill on timeout) and a pgrep confirmation by unique artifact marker decides the flag on EVERY path; failure to verify reports false.
- **DNS rebinding closed**: webfetch connections are pinned to the validated addresses via an undici dispatcher whose lookup returns only pre-approved IPs - validation and connection cannot resolve differently; redirect hops each get their own pinned agent.
- **Reserved-address table completed**: full special-purpose IPv4/IPv6 coverage (IANA, TEST-NETs, benchmarking, multicast, reserved, broadcast, documentation prefix).
- **Filesystem snapshot honesty**: an incomplete baseline (5000-file / size caps) refuses detonation; an incomplete post-scan fails the diff - never a silent pass.
- **WSL guest node resolution fixed**: the pipeline now execs the discovered `$NODE_BIN` (the hardcoded `/usr/bin/node` contradicted the dynamic lookup - a distro with node elsewhere failed despite a working install).
- **Streaming output budgets**: runner output is capped while streaming (BoundedOut); exceeding the budget terminates the run instead of accumulating unbounded memory.
- Regression tests: expanded reserved-range cases, snapshot honesty, output-budget termination.

## [0.0.3b] - 2026-11-22 - detonation sandbox hardening + cross-platform coverage

- **Detonation lane: real OS-level isolation, one backend per platform.** Windows: WSL2 namespace runner (mount+pid+net namespaces, host drives detached, privilege drop). Linux (incl. Arch/Omarchy): bubblewrap - unprivileged, full filesystem isolation (only the delivered artifact dir and the runtime visible), no network. macOS: Seatbelt (network denied, writes confined - Apple deprecates sandbox-exec; best-effort, stated). Artifact delivered into a private guest copy on every backend; the host temp dir never executes. Process-tree termination confirmed by pgrep on every completion path, timeout included. Network isolation verified from inside the guest.
- **Layered quarantine:** git baseline captured BEFORE execution + bounded fs-snapshot layer that catches git-invisible ignored-file changes; a quarantine failure fails the run.
- **CI is now the permanent adversarial reviewer:** the end-to-end detonation suite runs real artifacts on Linux runners and skips with stated reasons where the stack is absent (guest node missing, unshare privileges unavailable). Live CI iterations found and fixed: hardcoded node path, unbound `/usr/local`, Windows backslashes in the Linux guest, missing private staging copy, timer-path tree confirmation.
- Everything in [0.0.3a](#003a) carries forward.

## [0.0.3a] - 2026-11-21 - second public alpha (durable work + security consolidation)

- Durable Agent Run (Phase 1-4): runs are first-class SQLite entities with a validated state machine and append-only timeline; restarts mark in-flight runs `interrupted`; `POST /api/runs/:id/resume` re-drives the loop with the objective + timeline digest; Runs panel in the workbench; SOP gates survive restarts.
- Security consolidation from the external source audit: detonation quarantine baseline now captured BEFORE execution (P0); webfetch SSRF guard (private ranges/redirect hops/bounded reads); tool-call protocol persisted (no orphaned tool responses); tool-call budget (24/turn); bounded read/edit; credential denylist extended (.ssh, cloud credentials, .npmrc, docker config, private-key formats); MCP init failures tear the child down; SOP agent nodes receive earlier-node context; session worktree restored across restarts; audit log uses sha256 (was reversible base64).
- Right-click refactor: main-process context-menu relay + shader-layering exemptions (menu and toasts now always render on-screen); terminal right-click copy/paste; toasts top-center.
- Engine + LSP: engine registration survives stop/start cycles; LSP diagnostics (capability + URI normalization + pull-first); GGUF template auto-detection from embedded metadata.

## [0.0.2] - 2026-11-18 - alpha patch

- Linux/Wayland: renderer-load failures now show an in-window error page with the exact cause and fix instead of a blank window.
- Windows packaging: NSIS installer only; MSI target removed until real icon artwork exists (WiX `LGHT0094`).
- Trademark filing checklist added (`docs/TRADEMARK.md`); MIT core and commercial-artifact policy documented in README.

## [0.0.1] - 2026-11-17 — first alpha release candidate

First tagged alpha. (The `0.1.0` entry below was an internal pre-tag scaffold marker; the release line starts here.)

### Highlights
- Local-first runtime: attach-first single server, renderer holds no API credential (main-process proxy + single-use event tickets), zero-download model policy.
- Tools: permission gates with prefix patterns, workspace containment (sibling/symlink/junction/dangling-proof), bounded bodies, approval authority the model cannot self-grant, declarative read-only `run_js` batch.
- Agent: bounded loop with per-session serialization, cooperative cancel + global operator pause, SOPs with immutable script-node approval, checkpoints/forks, memory/engram, MCP, LSP, TTS.
- Workbench: Monaco + LSP, PTY, panels, session manager with live bulk delete, right-click file ops and text menu, capability discovery, approvals queue, real worktree in the status bar.
- Assurance: MIT attribution, RELEASE/ROADMAP/UIUX-AUDIT docs, four independent audit sweeps recorded and remediated, 12-stage `npm test` including an isolated end-to-end smoke, release workflow gated on tests + SHA-verified engine staging.

### Known issues (stated, not hidden)
- Windows compositor can present a stale frame under heavy GPU load; one click recovers. All in-app triggers found are fixed.
- `sbx` microVM, whisper STT, AfterImage engram, and `aw` CLI are not bundled — absent capabilities are stated plainly in-app; detonation artifact delivery into the VM is not implemented.
- Session switching reloads the workbench window; in-place tabs are roadmap.
- No app icon or code signing yet; Linux/macOS engine staging is roadmap.

## [0.1.0] - scaffold through first operational build

### Added
- Electron shell: multi-window, thin main process, preload auth bridge (IPC only).
- Local server (127.0.0.1, Basic auth, per-launch password): sessions, todos (SQLite WAL w/ memory fallback), worktrees, SSE events, ACP-compatible session endpoints, tool registry with allow/ask/deny gates.
- Language packs: 31 manifests (18 Tier 1, 13 Tier 2) driving lazy LSP/DAP, Toolchain Doctor, package-manager detection, ctags/regex fallback symbol index.
- Detonation lane: unclean-input router, tiered plans (review/execute/redteam), time-boxed microVM exec, git-status quarantine check.
- AgentWatch integration (opt-in): workspace/mailbox sweep, posture snapshot/diff, probe run/score, OTLP receiver lifecycle, acknowledgment store, gate v2 (acknowledged findings clear the block), canaries, loop detection.
- Engram glue: AfterImage subprocess (search w/ typed absence, TI-85 arithmetic verify); packs layout seeded.
- Skills: open Agent Skills standard, 31 generated stubs.
- Model router: Ollama direct (list + chat), BYOK OpenAI-compatible lane (.harness/secrets.json, gitignored), reasoning-model `thinking` capture, /think: effort levels.
- Engine manager Phase 1: bundled chonllama.cpp (chonk-buffer) sidecar — status/models/start/stop, GPU policy as engine flags (VVM_DEVICE_INDEX, GGML_VVM_HEAP_FRACTION, GGML_VK_VVM_POOL), local GGUF dir scanning. Verified against local build-vk binary (0.4.1-dev).
- Sensory S1: vision plumbing (image content parts both lanes), capability detection (eyes/ears/mouth), docs/SENSORY.md body plan.
- Workbench UI: activity bar, tabs, status bar, command palette (Ctrl+K), Monaco (language workers), xterm PTY terminal, Toolchain Doctor / Sandbox / AgentWatch panels, model+think pickers, shader background (WebGL2, intensity cycle, pauses when hidden).
- Runtime kit: runtime:init folder tree, headless serve, audit.jsonl, RUNTIME.md.
- Packaging: electron-builder config (asarUnpack natives, languages bundled, engine extraResources slot), CI (typecheck + drift check + engram shim), release workflow (publish never), MIT + NOTICE attribution (VS Code/Monaco, OpenCode, Electron, SolidJS, AfterImage/BlackICE, AgentWatch, chonkllama/VulkanVM, whisper.cpp, piper).
- Docs: ARCHITECTURE, SECURITY, PRIVACY, LANGUAGES, DOCKER, DETONATION, AGENTWATCH, ENGRAM_INTEGRATION, ENGINE, SENSORY, GPU (B70 training + 7900 XTX headroom policy).

### Notable live verifications
- End-to-end local completion via gemma4:e4b through the full stack; VRAM released after each call (keep_alive 0).
- PTY spawn/kill clean on Windows; stale-server guard proven (EADDRINUSE path); detonate router + approval gate verified in CI-style smoke.

### Known limits
- Renderer bundle ~4.8MB + 12MB TS worker (Monaco weight; lazy-load queued).
- better-sqlite3 v12 required on Node 26 (v11 fails source build — V8 API removals).
- Toolchain Doctor slow under heavy CPU contention (~80 probes, no cache yet).
