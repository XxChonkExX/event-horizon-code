# Changelog

All notable changes to Event Horizon Code. Newest first.
Format: Keep a Changelog; semver. Negative results are recorded, not hidden.

## [Unreleased]

- **BYOK keys are sealed with the OS keychain** (Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). New `src/server/secrets.ts`, `/api/secrets*`, and a BYOK section in the Models panel: save a key, see how each stored key is kept, seal existing plaintext values in place, two-step remove. Where no keychain is reachable (the headless runtime, Linux without a keyring) a saved key stays plaintext and the panel says so in warning colour - never a silent downgrade, and a sealed key is refused with the reason rather than guessed at. Keys are never returned by the status API, never shown after saving, never logged.
  - Verified end to end on Windows only: the built app seals a key, a fresh launch decrypts it, the agent lane sends the decrypted key to the configured endpoint; the same file handed to a headless runtime is refused with nothing sent. Linux and macOS proofs are pending on their own machines.
  - Negative result, recorded: on a brand-new profile the profile's wrapping key reaches disk about 10 s after the first launch (or at once on a normal close), so a key saved inside that window is lost - refused as `undecryptable`, never exposed - if the app is killed before the write. Not fixed; the envelope design in `docs/ENCRYPTION.md` is the option.
- **Credential denylist covers a relocated secrets file.** `EH_SECRETS_FILE` can place the file under any name, which the name-based rules did not know. `safePath` now compares the resolved path and the shell rule refuses the configured name. An empty `EH_SECRETS_FILE` means "not set".
- Tests: `secrets:test` (plain node, no keychain), `secrets:test:electron` (real keychain, two launches), `/api/secrets` in the end-to-end smoke, relocated-file cases in `wsguard:test` and `detonate:test`.
- Docs: SECURITY.md, PRIVACY.md and ENCRYPTION.md now state exactly what is built and what was verified. PRIVACY.md previously claimed an "encrypted file fallback" that did not exist. Closes audit item 17.

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
