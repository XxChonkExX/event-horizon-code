# Event Horizon Code

A local-first, desktop coding agent harness. Monaco (VS Code) + a real agent loop, real tools, and a bundled inference engine — for people who want a serious coding agent that runs on their own hardware with no telemetry, no cloud proxy and full operator control.

Ships as an Electron app (Windows, Linux, macOS) with a workbench UI modelled on OpenCode Desktop. No models are bundled: you choose what runs.

---

## TL;DR feature list

- **Agentic chat** with tools, memory, plan/`/think:low|medium|high|max` control, and a bounded self-correcting loop (max 4 steps, budgeted retries, context-overflow recovery).
- **Real agent tools** — read / write / edit / bash / grep / glob / run tests (`verify`), plus a JS programmatic tool-caller (`run_js`), exact arithmetic (`calc_verify`), and deterministic emulators (`ti85`, `pyvm`, `rv32`, `z80`, `m6502`, `thumb2`, `dataflow`) via AfterImage.
- **Bundled inference engine** — `chonkllama.cpp` sidecar (OpenAI-compatible `/v1`, Vulkan, Chonk Buffer pool); also routes to **Ollama** or any **BYOK OpenAI-compatible** endpoint. Ladder: engine → Ollama → BYOK.
- **Tool calling that actually works** — llama-server serves *69 canonical Jinja templates* (Qwen, DeepSeek, Gemma, GLM, Granite, Llama, Mistral, gpt-oss, …) with automatic family detection, so fine-tuned GGUFs get real tool calls instead of narration.
- **Sessions** — persistent SQLite store, durable instructions (`remember`), conversation compaction, **fork/branch a session**, **checkpoints per turn**, session rename/delete, hand-off between windows.
- **SOPs** — repeatable workflows (agent nodes + deterministic script nodes + **human gates** with send-back), adapted from Tencent LoopForge (MIT). Gated by default; **automated mode** available as a preference (gates auto-approve).
- **Multi-window workbench** - activity bar, tabbed editor (Monaco) with live LSP hover/diagnostics (TypeScript), real integrated PTY with tabs, panel pop-outs, resizable splitters, live token streaming, slash-commands, toasts, right-click menus (copy/paste/select-all; file ops in the sidebar), and a Session log manager (search, sort, hide/restore, bulk delete).
- **Local memory & engram** — workspace memory (`AGENTS.md`, `.harness/memory.md`), AfterImage engram search/register with typed absence, and an AfterImage verification path for exact claims.
- **Speech** — text-to-speech adapters (system / engine Pocket-TTS / piper) with swappable voices; speech-to-text (whisper.cpp) surface is implemented and refuses plainly until sidecars are installed.
- **Security-first tool use** - per-tool permission gates (`allow`/`ask`/`deny`), shared workspace containment guard (sibling-prefix, traversal and symlink/junction proof, realpath canonicalisation), single-use event-stream tickets (the master password never rides in a URL), bounded request bodies, approval authority that the model cannot self-grant, detonation lane for unclean inputs (`run_js` review/execute/redteam tiers), no telemetry, audit log with rotation and health reporting (`~/.eventhorizon/audit.jsonl`).
- **One runtime, zero downloads** - the Electron shell attaches to an existing local runtime (or spawns exactly one); two servers on one database cannot happen. Missing models are refused with the command you can run - nothing is ever pulled over the network.

## Known issues (stated, not hidden)

- **Windows compositor**: under heavy GPU load a window can present a stale frame; a single click recovers it. Every in-app trigger found by two independent audits is fixed; the machine-level trigger remains under investigation (`docs/GPU.md`).
- **Not bundled**: speech-to-text (whisper sidecar), the `sbx` microVM sandbox (the detonation lane refuses plainly without it), the AfterImage engram (imported via subprocess - see `docs/ENGRAM_INTEGRATION.md`), and the AgentWatch `aw` CLI. Every absent dependency is stated plainly in the UI rather than faked.
- **Packaging cosmetics**: default Electron icon, no code-signing certificate.
- **Session switching** reloads the window (in-place tabs are on the roadmap).
- **Linux/macOS builds**: the runtime is portable (llama.cpp engine, native Ollama, BYOK to any OpenAI-compatible server - including your own llama-server), but the packer currently stages Windows binaries only. An [Omarchy](https://omarchy.org) shell plugin is on the roadmap after the Linux build.

## Release

The full hand-driven pipeline lives in [`docs/RELEASE.md`](docs/RELEASE.md): version bump, pre-flight tests, engine staging with SHA-256 verification, `pack:dir`, a release-candidate checklist, artifact hashing, and the tag/publish template. `npm run pack:dir` has been verified end-to-end (engine staged, RC launched, own runtime, health green).

## Requirements

- **Node.js 22+** (Electron 42, npm packages)
- **Windows 10/11, Linux, or macOS** (prebuilt `node-pty` and engine templates included; the inference engine binary is machine-specific - see [Engine](#engine-setup) below).
- A model: either a **GGUF** for the bundled engine *(e.g. `huihui-qwen3-4b-abliterated-v2-q8_0.gguf`, `Qwen3-4B`, `DeepSeek-Coder`, `Llama-3-8B-Instruct`, `Gemma-3-12b`)* or **Ollama** or a **BYOK** OpenAI-compatible endpoint.
- Optional: **Python 3.8+** (AfterImage engram, TI-85 verification), **Ollama**, **ripgrep / fd** (JS fallbacks are built in if absent).

## Zero copy · zero download · zero dependency

The inference stack is yours. EHC **never downloads a model, never copies weights, never installs a dependency on your behalf** - if a model tag is missing, EHC tells you and stops (Ollama's implicit auto-pull is explicitly blocked in the model router).

No Ollama? You don't need it. The model ladder works without it on every platform:

1. **Bundled engine** - llama.cpp's `llama-server` (the chonkllama fork, Vulkan/Chonk pool on Windows) speaking the OpenAI dialect on a local port. The binary is staged per machine (`scripts/prepare-engine.mjs`); on Linux/macOS a platform `llama-server` build takes its place.
2. **Your own llama.cpp** - point `engine.binaryPath` in `.harness/config.json` at any `llama-server` you built (Linux, macOS, Windows - same OpenAI dialect).
3. **BYOK** - any OpenAI-compatible endpoint: a self-hosted `llama-server`, LM Studio, vLLM, llamafile. One API key field, nothing else.

Ollama is a *convenience*, not a requirement (native Linux/macOS/Windows builds exist if you want it).

Roadmap (post-alpha): Linux/macOS engine staging in the packer, an [Omarchy](https://omarchy.org) shell plugin (bar widget + session menu driven by the local runtime API), speech-to-text sidecar. The full strategic roadmap - durable Agent Runs, Mission Control, independent review agents, AgentWatch evolution, the evaluation lab - lives in [`docs/ROADMAP.md`](docs/ROADMAP.md), with implemented/scaffolded status marked per item.

## Quick start

```bash
git clone https://github.com/XxChonkExX/event-horizon-code.git
cd event-horizon-code
npm install
electron_dev=1 npm run dev    # Windows PowerShell: $env:EH_PASS="dev123"; npm run dev
```

First run: Electron opens the workbench. Pick a model (see below), and say *"summarise what this repository is"* - the agent will inspect the workspace itself.

**Desktop/Start Menu shortcuts (Windows):** `npm run desktop:install` creates a Desktop and a Start Menu shortcut with the event-horizon artwork (`--uninstall` removes them). Taskbar pinning is one right-click away - Windows restricts scriptable pinning.

**Headless runtime (for scripts/CI):**
```bash
EH_PASS=dev123 npm run serve    # http://127.0.0.1:4126, Basic auth eventhorizon:dev123
curl -u eventhorizon:dev123 http://127.0.0.1:4126/global/health
```

**Tests:** `npm test` (≈140 checks: typecheck + LSP + detonation gate + tool-search + SOP + sessions + memory + sensory + TTS).

## Engine setup

The bundled engine is **chonkllama.cpp** (an MIT-licensed, Vulkan-accelerated fork of llama.cpp with a Chonk Buffer GPU memory pool). It is **not** bundled as a binary here; you bring a build or point EHC at one:

1. **Machine-specific binary** (this dev build): `.harness/config.json → engine.binaryPath`
2. **Packaged binaries** (SHA-pinned, for installers): dropped into `resources/engine/`
3. **Env override:** `EH_ENGINE_BIN=/path/to/llama-server`

Everything else is automatic: `GET /api/engine/models` scans `~/.eventhorizon/models`, `./models`, and config-added dirs for GGUFs; `POST /api/engine/start` loads one with `--jinja` (required for tool calling) and `-c 8192` (context kept small so it coexists with other GPU work); `GET /api/engine/templates` auto-detects the model family and supplies the matching tool-capable chat template.

**Ollama lane:** `ollama serve`, then models appear in the picker; capabilities are probed live via `POST /api/show` and shown as badges.

**BYOK:** `.harness/secrets.json` (gitignored) —
```json
{ "openai": { "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-..." } }
```

## Security & privacy posture

- **No telemetry, no analytics, no cloud proxy.** All network calls go to endpoints you configure (Ollama on localhost, BYOK, or none).
- Local server binds `127.0.0.1` with Basic auth; the Electron shell attaches to an existing runtime (or spawns exactly one) and logs the port. The **renderer never receives the API password** — JSON calls go through a main-process proxy, streams use single-use tickets. User keys live in `.harness/secrets.json` (gitignored).
- **Permission gate** on every tool: `allow` / `ask` / `deny` in `.harness/config.json` (`permissions`). `edit` / `write` / `bash` default to `ask`; the composer's **auto-approve tools** toggle flips them.
- **Workspace path jail** — tools cannot write outside the workspace; credential files (`.harness/secrets.json`, `.env`) are never agent-readable or agent-writable.
- **Detonation lane** - requires an operator-installed `sbx` microVM; **without it the lane refuses plainly** (never a silent host fallback). Artifact delivery into the guest is not yet implemented and is not claimed — see the implemented/planned table in `docs/DETONATION.md` and `docs/SECURITY.md`.
- Every tool call, model call, escalation and context recovery is appended to `~/.eventhorizon/audit.jsonl`.
- Detonated tools (`run_js` with `tier=execute|redteam`) require `sbx`; without it the tool refuses plainly.

## Multi-window agents & SOPs

- **`/think:low|medium|high|max`** per message; per-session reasoning slider; per-profile defaults.
- **SOPs** (`.harness/sops/*.json`) — repeatable multi-step workflows: agent nodes, deterministic `script` nodes, and **human-gate nodes** that pause for review with *approve* / *send back* semantics (adapted from Tencent LoopForge, MIT). Run with `POST /api/sops/<name>/run`. A run can be **gated** (human gates pause) or **automated** (gates auto-approve, for unattended scheduled work) — set per run or in `.harness/config.json → sop.defaultMode`.
- **Fork a session** from any checkpoint and open the branch in a new window — two agent approaches, one untouched original.
- Sessions, memory, profiles, and checkpoints all persist in SQLite (`~/.eventhorizon/data.db`).

## Engram (AfterImage)

Local, deterministic knowledge store — no vector DB, no embeddings, no network. Pinned corpus is indexed from local files. Gives typed-absence answers (*"NO RECORDS, do not guess"*) and TI-85-verified arithmetic. See `docs/ENGRAM_INTEGRATION.md`. You bring the corpus; EHC imports it, it never ships a corpus.

## Attribution

This project borrows with gratitude and full attribution (see **NOTICE.md**):

- **Microsoft VS Code / Monaco** (MIT) — the editor component.
- **OpenCode** (MIT) — client/server agent loop shape, session model, permission model.
- **llama.cpp / chonkllama.cpp** (MIT/MIT) — bundled engine + 69 canonical chat templates.
- **AfterImage-Engram** (MIT, XxChonkExX) — typed absence, deterministic machines, TI-85 verifier.
- **LoopForge** (MIT, Tencent) — SOP workflow model (agent/script/gate nodes).
- **Electron** (MIT), **SolidJS** (MIT), **whisper.cpp** (MIT), **Piper** (MIT), **Docker Sandboxes** (docs only), plus model-family templates from their authors.

Model weights are never bundled or shipped; community models you choose yourself remain under their licenses.

## License, trademark & commercial artifacts

MIT © 2026 XxChonkExX / Event Horizon Code contributors. The core workbench,
agent loop, tools, SOPs, MCP, LSP, and assurance features stay free and open —
all current features are core, not artificially held back.

**Trademark:** "Event Horizon Code" and its logo are trademarks of XxChonkExX.
The MIT license grants no trademark rights; forks may not use the name or logo
to imply endorsement or to rebrand a resold copy. (Registration pending.)

**Commercial artifacts** (sold separately, not required to use the core):
signed/notarized installers with auto-update, team policy and audit aggregation,
priority support. The open-core commitment above is the product boundary;
contributions to the core stay under MIT.

Roadmap and UI/UX audits: [`docs/ROADMAP.md`](docs/ROADMAP.md) and
[`docs/UIUX-AUDIT.md`](docs/UIUX-AUDIT.md).

---

Status: **v0.0.2 (alpha patch)**. Windows is the verified packaged target; the local runtime also builds/runs from source on Linux and macOS, but per-platform engine staging in the packer is still roadmap. Rough edges and deferrals are documented in `docs/`; please file issues.
