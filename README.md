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
- **Speech** — text-to-speech adapters (system / engine Pocket-TTS / piper) with swappable voices, and **speech-to-text in the composer**: press the mic, speak, press again - whisper.cpp transcribes on your machine and the text lands in the composer for review. Several microphones? Pick one. The engine and language models are an optional, checksum-verified download.
- **Security-first tool use** - per-tool permission gates (`allow`/`ask`/`deny`), shared workspace containment guard (sibling-prefix, traversal and symlink/junction proof, realpath canonicalisation), single-use event-stream tickets (the master password never rides in a URL), bounded request bodies, approval authority that the model cannot self-grant, detonation lane for unclean inputs (`run_js` review/execute/redteam tiers), no telemetry, audit log with rotation and health reporting (`~/.eventhorizon/audit.jsonl`).
- **One runtime, no forced downloads** - the Electron shell attaches to an existing local runtime (or spawns exactly one); two servers on one database cannot happen. Missing models are refused with the command you can run; nothing is ever pulled over the network unless you click a download.
- **Toolchain Doctor with install links** - probes 73 tools across 31 language packs; every missing one gets an `install` link to its official page (Rust, Clang, Ruby, Node, Go, Java, Docker, …). Nothing is installed for you.

## Known issues (stated, not hidden)

- **Windows compositor**: under heavy GPU load a window can present a stale frame; a single click recovers it. Every in-app trigger found by two independent audits is fixed; the machine-level trigger remains under investigation (`docs/GPU.md`).
- **Not bundled**: the whisper.cpp speech engine and its models (an optional download, or your package manager), the AfterImage engram (imported via subprocess - see `docs/ENGRAM_INTEGRATION.md`), and the AgentWatch `aw` CLI. The detonation lane uses OS-level sandbox backends (WSL2 namespaces on Windows, bubblewrap on Linux, Seatbelt on macOS) - if none is available it refuses plainly. Every absent dependency is stated plainly in the UI rather than faked.
- **Packaging cosmetics**: default Electron icon, no code-signing certificate.
- **Linux builds**: AppImage + deb are packaged and verified live (0.0.3d); the Windows packer stages the Vulkan engine binaries, while Linux runs use your own llama.cpp/Ollama or the engine from source. An [Omarchy](https://omarchy.org) shell plugin (sessions bar widget + panel) ships in `integrations/omarchy/`. **0.0.4a publishes Windows and Linux installers;** macOS runs from source.

## Release

The full hand-driven pipeline lives in [`docs/RELEASE.md`](docs/RELEASE.md): version bump, pre-flight tests, engine staging with SHA-256 verification, `pack:dir`, a release-candidate checklist, artifact hashing, and the tag/publish template.

**Downloads ([releases](https://github.com/XxChonkExX/event-horizon-code/releases))** - tagged `0.0.4a`, marked latest:

| Platform | Artifacts |
|---|---|
| Windows 10/11 | NSIS installer + MSI (Vulkan engine staged) - built and verified for this release |
| Linux (AppImage/deb/rpm) | built from the same commit as the Windows installers; launched and checked on Ubuntu 26.04 (WSLg). Engine-less: use your own llama.cpp, Ollama or BYOK |
| macOS | runs from source; not packaged yet |
| Source | zip at each tag |

Every release ships a SHA-256 sheet; the binaries are unsigned, so verify before running.

## Requirements

- **Node.js 22+** (Electron 42, npm packages)
- **Windows 10/11, Linux, or macOS** (prebuilt `node-pty` and engine templates included; the inference engine binary is machine-specific - see [Engine](#engine-setup) below).
- A model: either a **GGUF** for the bundled engine *(e.g. `huihui-qwen3-4b-abliterated-v2-q8_0.gguf`, `Qwen3-4B`, `DeepSeek-Coder`, `Llama-3-8B-Instruct`, `Gemma-3-12b`)* or **Ollama** or a **BYOK** OpenAI-compatible endpoint.
- Optional: **Python 3.8+** (AfterImage engram, TI-85 verification), **Ollama**, **ripgrep / fd** (JS fallbacks are built in if absent).

## Zero telemetry · zero cloud · downloads only when you click

The inference stack is yours. EHC **never downloads a model, copies weights or installs a dependency on its own** - if a model tag is missing, EHC tells you and stops (Ollama's implicit auto-pull is explicitly blocked in the model router). The only things it can download are the speech engine and language models offered in the Sensory panel, and only when you click **download**: official sources, exact size and SHA-256 pinned, verified before anything is installed. Every other missing tool gets a link to its official install page instead of an installer. Details: [Speech](#speech-voice-input-and-text-to-speech) and [`docs/PRIVACY.md`](docs/PRIVACY.md).

No Ollama? You don't need it. The model ladder works without it on every platform:

1. **Bundled engine** - llama.cpp's `llama-server` (the chonkllama fork, Vulkan/Chonk pool on Windows) speaking the OpenAI dialect on a local port. The binary is staged per machine (`scripts/prepare-engine.mjs`); on Linux/macOS a platform `llama-server` build takes its place.
2. **Your own llama.cpp** - point `engine.binaryPath` in `.harness/config.json` at any `llama-server` you built (Linux, macOS, Windows - same OpenAI dialect).
3. **BYOK** - any OpenAI-compatible endpoint: a self-hosted `llama-server`, LM Studio, vLLM, llamafile. One API key field, nothing else.

Ollama is a *convenience*, not a requirement (native Linux/macOS/Windows builds exist if you want it).

Roadmap (post-alpha): macOS packaging, in-app speech downloads for Linux and macOS, and engine staging for Linux in the packer. Speech-to-text shipped in 0.0.4a; the Omarchy shell plugin in 0.0.3d. Designs for the next step - a camera window and sensor suite ([`docs/SENSORS.md`](docs/SENSORS.md)) and a minimal hardened browser window ([`docs/BROWSER.md`](docs/BROWSER.md)) - are written up and await a decision; nothing in them is implemented. The full strategic roadmap - durable Agent Runs, Mission Control, independent review agents, AgentWatch evolution, the evaluation lab - lives in [`docs/ROADMAP.md`](docs/ROADMAP.md), with implemented/scaffolded status marked per item.

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

**Tests:** `npm test` - 20 stages, all offline: typecheck, containment, secrets, DNS pin, LSP, detonation gate, tool-search, SOPs, sessions, runs, memory, sensory, optional downloads, TTS, engram, then an end-to-end smoke.

## Engine setup

The bundled engine is **chonkllama.cpp** (an MIT-licensed, Vulkan-accelerated fork of llama.cpp with a Chonk Buffer GPU memory pool). It is **not** bundled as a binary here; you bring a build or point EHC at one:

1. **Machine-specific binary** (this dev build): `.harness/config.json → engine.binaryPath`
2. **Packaged binaries** (SHA-pinned, for installers): dropped into `resources/engine/`
3. **Env override:** `EH_ENGINE_BIN=/path/to/llama-server`

Everything else is automatic: `GET /api/engine/models` scans `~/.eventhorizon/models`, `./models`, and config-added dirs for GGUFs; `POST /api/engine/start` loads one with `--jinja` (required for tool calling) and `-c 8192` (context kept small so it coexists with other GPU work); `GET /api/engine/templates` auto-detects the model family and supplies the matching tool-capable chat template.

**Ollama lane:** `ollama serve`, then models appear in the picker; capabilities are probed live via `POST /api/show` and shown as badges.

**BYOK:** save it in the app under **Models → BYOK secrets**: base URL, API key, and the model the agent should use. The key is sealed with the OS keychain (Electron `safeStorage`: DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux) and written to `.harness/secrets.json` (gitignored) as `enc1:<ciphertext>`. The provider then appears in the composer's model picker as `byok:<provider>` (and can be set as a profile's model). **test** fires one 1-token completion through the same call the agent makes; the panel shows each provider's endpoint and storage state; **Encrypt stored keys** seals hand-written plaintext keys behind a plaintext backup it offers first. The file can also be edited by hand — plaintext, which is also what a headless runtime (`npm run serve`) can use, since it cannot reach a keychain and says so:
```json
{ "openai": { "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "model": "gpt-4o-mini" } }
```
Verified end to end on Windows; the Linux keyring proof is verified natively on GNOME/Wayland; macOS is pending — see `docs/ENCRYPTION.md`.

## Speech: voice input and text-to-speech

**Voice input.** Press the microphone button in the composer, speak, press it again. The text is inserted into the composer for you to edit - it is never sent on its own. While recording you get a live level meter, a clock and a discard button; recording stops by itself after 60 s. More than one input? The picker next to the button chooses and remembers it.

It needs two pieces, and **neither is bundled**: the `whisper-cli` engine and a language model. Three ways to get them, none required for anything else in the app:

1. **Optional download** (Windows x64 / ARM64) - Sensory panel → **download**. The engine comes from the official whisper.cpp release, the models from the project's own repository. Each is pinned to its exact size and published SHA-256 and verified before it is installed; one at a time, with progress and cancel. `Small - English` is the recommended model for English (about 5× faster than real time on a CPU); multilingual models cover about 100 languages. Nothing is downloaded until you click, and no request is made before that.
2. **Your package manager or build** - `brew install whisper-cpp`, `pacman -S whisper.cpp`, or built from source. `whisper-cli` on `PATH` is found automatically.
3. **By hand** - drop `whisper-cli` / `whisper-cli.exe` and any `ggml-*.bin` into `~/.eventhorizon/sensory/`, or point `.harness/config.json` → `sensory.stt.{bin,model,language}` at them.

**Text-to-speech.** A **speak** button on every reply and a voice picker under **options**: the OS voices on Windows, the engine's own TTS on Linux/macOS/ARM, or piper as an optional sidecar.

**Coding toolchains.** The Toolchain Doctor probes 73 tools across 31 language packs. Every missing one gets an **install** link to its official page - Rust, Clang, GCC, Ruby, Node, Python, Go, Java, Kotlin, Swift, Docker and more - with a footnote where Windows needs a second step (Rust also wants the Visual Studio C++ Build Tools). Links open in your browser; the app installs nothing.

## Security & privacy posture

- **No telemetry, no analytics, no cloud proxy, no update check.** Traffic leaves this machine only for endpoints you configure (Ollama on localhost, BYOK, or none), for an optional download you click (github.com / huggingface.co, checksum-verified), for an install link you click (opened in your own browser), or for the `websearch` tool you approve.
- **Microphone only while you record, camera never.** Audio is transcribed on this machine by whisper.cpp and is never stored or uploaded. The app's own windows keep Electron's default permissions (so clipboard copy and terminal paste work); the camera is refused to every page.
- Local server binds `127.0.0.1` with Basic auth; the Electron shell attaches to an existing runtime (or spawns exactly one) and logs the port. The **renderer never receives the API password** — JSON calls go through a main-process proxy, streams use single-use tickets. User keys live in `.harness/secrets.json` (gitignored), sealed with the OS keychain when saved from the app.
- **Permission gate** on every tool: `allow` / `ask` / `deny` in `.harness/config.json` (`permissions`). `edit` / `write` / `bash` default to `ask`; the composer's **auto-approve tools** toggle flips them.
- **Workspace path jail** — tools cannot write outside the workspace; credential files (`.harness/secrets.json`, `.env`) are never agent-readable or agent-writable.
- **Detonation lane** - untrusted code executes inside per-platform OS-level sandboxes: WSL2 namespaces (Windows), bubblewrap (Linux), Seatbelt (macOS, best-effort). Artifact delivery, host-drive detachment, network isolation, and pgrep-confirmed tree termination are implemented and verified - with per-mechanic verification flags in every result and honest failure when any cannot be verified (`docs/DETONATION.md`).
- Every tool call, model call, escalation and context recovery is appended to `~/.eventhorizon/audit.jsonl`.
- Detonated tools (`run_js` with `tier=execute|redteam`) require a sandbox backend - WSL2 namespaces (Windows), bubblewrap (Linux), or Seatbelt (macOS); without one the tool refuses plainly, never a silent host fallback.

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

Status: **v0.0.4a (alpha)**. Windows (NSIS/MSI, Vulkan engine) and Linux (AppImage/deb/rpm, engine-less) are packaged; macOS runs from source. Rough edges and deferrals are documented in `docs/`; please file issues.
