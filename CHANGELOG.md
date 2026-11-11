# Changelog

All notable changes to Event Horizon Code. Newest first.
Format: Keep a Changelog; semver. Negative results are recorded, not hidden.

## [0.1.0] — scaffold through first operational build

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
