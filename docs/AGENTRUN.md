# Durable Agent Run (Phase 1) — design + current state

> Session = conversation. Run = work being performed. A run survives window
> close, restart, and model switch.

## Why

Before Phase 1, the only durable artifacts were the conversation (messages),
checkpoints, and the audit log. The *work* itself — an agent turn with its
model calls, tool calls, approvals, budget escalations, and outcome — existed
only in memory and a firehose audit log. You could not answer "what is the
agent doing right now", "what did it do in that run", or "what was in flight
when the machine restarted". SOP runs added a run record but kept it in an
in-memory Map (lost on restart). Phase 1 makes the run a first-class, durable
entity and generalizes it beyond SOPs.

## State machine

```
queued ──▶ planning ──▶ running ──▶ verifying ──▶ completed
   │           │           │  ▲          │
   │           │           │  └─ awaiting_approval
   │           │           ├─▶ checkpointed
   │           │           ├─▶ needs_repair ──▶ planning/running
   │           │           ├─▶ failed / cancelled
   │           └─▶ failed / cancelled
   └─▶ failed / cancelled

running/awaiting_approval/checkpointed/planning/queued
        ──(runtime restart at boot)──▶ interrupted ──▶ running (resume, later phase)
```

- Transitions are **validated** (`agentrun.ts` TRANSITIONS table): an illegal
  move is refused with an error naming both states. Terminal states
  (`completed`/`failed`/`cancelled`) have no exits.
- Every accepted transition appends a `state.change` timeline event and an
  audit entry (`agentrun.state`).

## Storage (SQLite, same DB as sessions)

- `runs` — id, sessionId, objective, workdir, state, lane, model, started,
  updated, ended, error, result. The row carries the disposition: `error` and
  `result` are written onto the row, not just the timeline.
- `run_events` — append-only timeline: (runId, seq) PK, ts, kind, detail
  (capped 1000 chars per event).
- Memory fallback follows the store's existing honest-degradation rules.

## Timeline event kinds

`run.created`, `state.change`, `model.ok`, `model.error`, `tool.call`,
`tool.ok`, `tool.fail`, `budget.escalate`, `checkpoint`, `run.completed`,
`run.failed`, `run.cancelled`, `run.interrupted`.

## Agent-loop wiring

`runAgentTurn` (the ONE loop shared by chat, SOP agent nodes, and future
multi-agent windows) creates a run at turn start (`queued` → `running`), emits
the events above at the existing discipline points (same places it audits), and
disposes the run at its exit paths: cancelled > completed (`result` = final
reply) > failed (`error` = the stated reason). The serving lane is persisted on
the run row. Persistence is best-effort — a storage failure never breaks a
live turn.

## Boot recovery

At server start (`startLocalServer`), any run found in an active state
(`queued`/`planning`/`running`/`awaiting_approval`/`checkpointed`) is marked
**`interrupted`** with `ended` set and a `run.interrupted` event. The
conversation survived (messages persist); the work stopped — stated, never
silently dropped. Terminal runs are untouched.

## API

| Route | Meaning |
|---|---|
| `GET /api/runs?sessionId=` | list runs (newest first, 200 cap) |
| `GET /api/runs/:id/timeline` | run + ordered event timeline |
| `POST /api/runs/:id/cancel` | transition to `cancelled` + cooperative cancel of the turn's session |

`POST /api/acp/session/prompt` creates and drives runs implicitly — chat needs
no run bookkeeping to keep working.

## Test coverage

`npm run runs:test` (in the `npm test` chain): 28 checks — create/read,
validated transitions, ordered timeline, terminal refusal, reopen durability
(close/reopen proves SQLite persistence), boot recovery flips stale runs and
leaves terminal runs alone, agent-loop integration (no-model turn → exactly one
`failed` run with the reason, lane `none`, full timeline), cancel path. The
9-check smoke also asserts the echo turn records a failed run with a timeline
via the HTTP API.

## Phases

1. **(this)** durable record + validated state machine + timeline + boot
   recovery + cancel API + loop wiring.
2. Resume execution: `interrupted` runs re-enter `running` with a replay of the
   timeline (objective + history already persisted; the model call restarts).
3. Execution timeline UI: a panel reading `/api/runs/:id/timeline` (SSE-ready —
   `agentrun.state` audit entries already streamable).
4. SOP runs migrate from their in-memory Map onto this store (their gates map
   to `awaiting_approval`).
