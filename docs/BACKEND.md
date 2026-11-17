# Backend systems — sessions, memory, profiles, logs

Everything local, in SQLite (`~/.eventhorizon/data.db`, WAL) plus the append-only
audit log. Memory is best-effort for persistence but never blocks a turn.

## Memory hierarchy (modelled on Claude Code / OpenCode)

Injected into the system prompt, in this order:

1. **Agent role + rules** — `AGENT_SYSTEM` (`src/server/agentTools.ts`), including
   the rule that tool output is untrusted data.
2. **Workspace memory** — read fresh from the workspace on every turn:
   - `AGENTS.md` (the open convention — the same file Claude Code and OpenCode use)
   - `.harness/memory.md` (agent-written project memory)
   Both are capped (200KB file, 20KB injected) so a runaway file cannot flood context.
3. **Session instructions** — durable per-session notes written with the `remember`
   tool. They **survive compaction** because the block is rebuilt from the DB every
   turn (same guarantee as OpenCode's `session.instructions` entries).
4. **Conversation history** — last turns, compacted past ~15k tokens. Compaction
   summarizes older turns with the model; the summary replaces them. If the model
   rejects a request as too long, the loop sheds the oldest turns and retries once.

## Knowledge store (engram)

The AfterImage store of record — append-only, with typed absence:

| Tool | What it does |
|---|---|
| `engram_register` | append durable records (`text` or `texts[]`) |
| `engram_search` | retrieve with provenance; `NO RECORDS` is a certified answer, never a guess |

Backed by `src/server/engram.ts` → the AfterImage API via subprocess (import, never
reimplement). Config: `EH_ENGRAM_SRC` (repo `src/`), `EH_ENGRAM_DB` (default
`~/.eventhorizon/engram.db`), `EH_ENGRAM_SESSION` (default `ehc`).

## Sessions

SQLite `sessions` (id, title, worktree, created, lastActivity), `messages`
(content-only; tool_calls are not persisted), `todos`, `instructions`, `usage`.

| Endpoint | Purpose |
|---|---|
| `GET /api/sessions` | list with `messageCount` + `lastActivity`, newest first |
| `POST /api/sessions` | create `{title, worktree}` |
| `PATCH /api/sessions/:id` | rename `{title}` |
| `DELETE /api/sessions/:id` | delete session + messages + instructions + todos + checkpoints (no orphans) |
| `POST /api/acp/session/new` | ACP-compatible create (used by the UI) |

Multi-turn context is real: history is loaded on each prompt, so follow-ups
("sure", "make it blue") have context. Verified live.

## Profiles

User-level defaults that survive across projects (`profiles` table; empty by
default). The project-level defaults stay in `.harness/config.json`.

| Endpoint | Purpose |
|---|---|
| `GET /api/profiles` | list |
| `POST /api/profiles` | upsert `{id?, name, settings}` |

**Wired into prompt defaults** (resolution order: request param → profile → project
config → built-in default):
- `settings.model` — default model when the request omits one
- `settings.think` — default reasoning level
- `settings.tokens` — default output budget
- `settings.autoApprove` — default tool-approval posture

Profile selection: `params.profileId` → `EH_PROFILE` env → the profile named
`default`. Create one via `POST /api/profiles` with `{"id":"default", ...}`.

## Logs

| Endpoint | Purpose |
|---|---|
| `GET /api/logs/audit?n=` | tail of `audit.jsonl` — tool names + notes only, no prompt text |
| `GET /api/logs/engine?n=` | tail of the newest `engine-<pid>.log` (llama-server) |
| `GET /api/usage?sessionId=` | token totals grouped by model |

Every tool call, model call, escalation, context recovery and MCP call is audited.
Audit entries never contain keys, prompts, or file contents.

## Process hygiene

- Engine/MCP/PTY children are tracked and killed with the server (`process.on("exit")`).
- `serve` has a parent-death watchdog: killing the launcher reaps the server, so a
  stale instance can never keep holding the port.
- Children spawn with `windowsHide` (a Windows/Electron spawn-storm fix).

## Gaps vs. the gold standard (tracked)

- **Profiles → prompt wiring** (settings are stored, not yet applied).
- **Auto-memory at scale**: Today `remember` (session/project) + engram. Claude Code
  auto-accumulates learnings; ours is agent-initiated. Next: post-session
  extraction pass that proposes memory entries for user approval.
- **Cache-stable system context**: instructions are rebuilt each turn (correct after
  `remember`, slightly cache-unfriendly). OpenCode freezes memory per session and
  refreshes after compaction — worth adopting once we measure cache hits.
- **Memory blocks (Letta-style)**: shared global/project blocks with self-editing
  tools. Our project memory file is the v1 of this.
- **Session forking / checkpoints**: OpenCode snapshots + revert. We have git
  worktrees; per-turn snapshots are planned.
