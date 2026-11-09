# Architecture

## Principles

1. Desktop-first. CLI is a debug aid, not the product.
2. Multi-window is first-class. 1 task = 1 window = 1 worktree.
3. Local server is the source of truth. Windows are projections.
4. Deterministic over magical. Engram retrieval is stemmed inverted index, not vector vibes.
5. No dependencies you did not ask for. Zero telemetry.

## Process map

- Electron Main: lifecycle, window manager (restore, geometry, focus, single-instance lock, deep links), menus, dialogs, notifications, updater (manual only), localhost server bootstrap (random port + per-launch password).
- Server (utility process / in-process Node): sessions, tools, permissions, worktrees, model router, engram service, SSE broadcast to all windows.
- Renderer (per window): SolidJS workbench, Monaco editor, chat, diff, file tree, terminal (xterm), status badges. Never reads filesystem via IPC. All file/git/model access goes through server HTTP/SSE.

## Protocol

- Editor <-> Server: JSON-RPC 2.0 over localhost HTTP + SSE, ACP-compatible method names (initialize, session/new, session/prompt, session/update, session/request_permission).
- Agent <-> Tools: MCP-compatible tools/call, definitions loaded progressively.
- Agent <-> Language: LSP/DAP clients (pyright, rust-analyzer, typescript-language-server, gopls via PATH discovery).

## Data

- SQLite WAL: sessions, messages, todos, engram index, audit pointers.
- Git snapshots: per-session worktree under .eventhorizon/worktrees/<id>/
- Engram store: engrams/index.db + verbatim log files under engrams/. Never compressed away. Ghost ledger for evictions. See AfterImage-Engram docs/EVIDENCE.md for measured recall.

## Reasoning

Per-message /think:, per-session slider, per-agent defaults. Budget forcing per model (budget_tokens / reasoning_effort). Verification round: model answers, TI-85 checks arithmetic claims, one repair round.

## Scaling

Idle: 1 server + N windows. Heavy: parallel worktrees, optional Docker per worktree for port/DB isolation in Phase 2.
