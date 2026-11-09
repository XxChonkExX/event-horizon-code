# Event Horizon Code

A clean, breakaway, Desktop-first coding harness.

Combines the multi-window agent workflow of OpenCode Desktop with the editor power of VS Code (Monaco, LSP/DAP, diff, terminal) into one local package. No telemetry. No cloud proxy. Local models first, bring-your-own-API second.

Built for Mac, Windows, and Linux.

## Models — no default shipped

No model is bundled, pinned, or promoted by Event Horizon Code. The user chooses at runtime/serve time (Ollama, llama.cpp, BYOK API). Local dev smoke tests use a small Qwen (e.g. `qwen2.5-coder:1.5b`) only to keep overhead low.

Author note: multi-GPU box — Intel Arc Pro B70 32GB (CodeRed-418 training) + AMD 7900 XTX (primary render). Event Horizon pins UI to the 7900 XTX, keeps B70 headroom (8GB free), and kills session processes on close. Dev stays light while training runs. See `docs/GPU.md`. Revisit a CodeRed-418 preset only after it finishes cooking.

## Name

Event Horizon Code (EHC). Not "Visual Studio" — that name is a Microsoft trademark. This project is an original work MIT-licensed, inspired by MIT-licensed upstream work with full attribution in NOTICE.md.

## Status

Scaffold / Phase 1. Electron shell + local server + Monaco workbench + git worktree multi-window agents + AfterImage Engram lookup.

## Quick start

```bash
git clone https://github.com/XxChonkExX/event-horizon-code.git
cd event-horizon-code
npm install
npm run dev
```

Packaged builds: `npm run pack` -> dist/ (.dmg, .exe/.msi, .deb/.rpm/.AppImage)

## Architecture

```
Electron Main (thin: windows, menus, deep links)
    |
    +-- Window A ─┐   git worktree /wt/A
    +-- Window B ─┼─► Local Server (TS/Node, SQLite)
    +-- Window C ─┘   sessions, tools, permissions, engrams
                      |
                      +-- Monaco + LSP/DAP
                      +-- LLM router (Ollama direct + BYOK API)
                      +-- Engram (AfterImage, deterministic)
```

Design docs: `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/PRIVACY.md`

## Engram

Local lookup brain for small models. Zero vector DB. Deterministic stemmed inverted index with typed absence, provenance, TI-85 verified arithmetic. See `engrams/` and `docs/ENGRAM_INTEGRATION.md`.

Pinned corpus is indexed from local files only. Example sources detected on this machine:
- `F:/llmtrainingpipeline/codetraining/` — C++ Standard Library, Python Standard Library by Example, HTML Standard, OWASP guides, kernel docs

No web fetching at runtime. Users pin their own SRDs / library docs locally and register them.

## Agent Skills

Open Agent Skills standard: `skills/<name>/SKILL.md` with progressive disclosure (metadata -> instructions -> references). First-party skills in `skills/`.

## Security / Privacy

- No telemetry SDKs, no analytics, no auto-update phone-home (manual check only)
- Local server binds 127.0.0.1, random port + per-launch password, Basic auth
- Secrets in OS keychain (Windows Credential Manager / macOS Keychain / libsecret), fallback encrypted file
- Every tool call logged locally to `~/.eventhorizon/audit.jsonl`
- Permissions: allow / ask / deny per tool pattern, per workspace

## Multi-window agents

1 task = 1 window = 1 git worktree = 1 branch. Coordinator agent can spawn workers in new windows. Closing a window does not kill work. Diffs reviewed centrally, merge or discard.

## Reasoning control

Per-message `/think:low|medium|high|max`, per-session slider, per-agent defaults. `plan` = medium, `build` = high, `explore` = low. Budget forcing per model. Verification loop via engram.

## Attribution

MIT. Full credit in NOTICE.md for Microsoft VS Code / Monaco, OpenCode, Electron, SolidJS, AfterImage-Engram (XxChonkExX, MIT).

(c) 2026 XxChonkExX / Event Horizon Code contributors
