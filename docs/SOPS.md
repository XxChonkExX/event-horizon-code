# SOPs - repeatable delivery workflows

Adapted from **Tencent LoopForge** (MIT, github.com/Tencent/LoopForge): when a way
of working proves itself, save it as an SOP so the next task is delivered the
same way. LoopForge orchestrates external coding CLIs in Docker sandboxes; this
is the local, in-process equivalent - SOP agent nodes run Event Horizon's own
agent loop (with tools) directly in the workspace. No Docker, no external
service, nothing leaves the machine.

## Node types

| Node | What it does |
|---|---|
| `agent` | A full agent turn - tools included - with a role persona (`default` or `coder`) and a per-node reasoning level. |
| `script` | A deterministic shell command in the run's worktree. No AI where AI is not needed. 120s timeout, output capped. |
| `gate` | **Human gate**: pauses the run until someone approves, or sends the work back to a chosen step. |

Rework edges: a node may declare `onFail: "<node id>"` - when it fails, the work
is sent back to that step (LoopForge's rework-on-failure). A rework loop is
bounded (`REWORK_LIMIT` = 12 total node executions) so a failing cycle fails the
run with a plain explanation instead of spinning forever.

## Run mode - the automated option, selectable by preference

| Mode | Behaviour |
|---|---|
| `gated` (default) | Human gates pause the run for approval. Agent tool calls follow the normal permission gates. |
| `automated` | Unattended: gates are auto-approved (recorded as `skipped - auto-approved`) and agent tool calls run with auto-approve. |

Precedence: run request (`POST .../run {mode}`) > SOP file (`mode` field) >
`.harness/config.json` `sop.defaultMode`. The chosen mode is recorded on the run.

This pairs with `session/set_mode` (`default` | `auto`) for plain chat: the same
preference controls whether an agent asks before touching files.

## SOP file format

`.harness/sops/<name>.json`:

```json
{
  "name": "bug-fix",
  "description": "Clarify, implement, test, human review, summarize.",
  "mode": "gated",
  "nodes": [
    { "id": "clarify",   "type": "agent",  "label": "Clarify",   "think": "medium",
      "prompt": "Investigate ... Do not change any files in this step." },
    { "id": "implement", "type": "agent",  "label": "Implement", "role": "coder", "think": "high",
      "prompt": "Apply the smallest fix described by the Clarify step." },
    { "id": "test",      "type": "script", "label": "Test", "cmd": "npm test", "onFail": "implement" },
    { "id": "review",    "type": "gate",   "label": "Human review",
      "note": "Approve, or send back to 'implement' with corrections." },
    { "id": "summarize", "type": "agent",  "label": "Summarize", "think": "low",
      "prompt": "Summarize this delivery in 5 bullets or fewer." }
  ]
}
```

Nodes run in array order; `start` names an explicit first node if you want one.
Each agent node receives the outputs of earlier nodes as context (labelled as
data, not instructions).

## HTTP surface

| Endpoint | Purpose |
|---|---|
| `GET /api/sops` | List SOPs (nodes summarised) + the configured default mode |
| `POST /api/sops/:name/run` | Start a run `{worktree?, sessionId?, mode?}` -> `runId` |
| `GET /api/sops/runs` | List runs (status, current node) |
| `GET /api/sops/runs/:id` | Full run record (per-node status + outputs) |
| `POST /api/sops/runs/:id/approve` | `{approved: true}` continue; `{approved: false, sendBackTo: "node"}` rework; `{approved: false}` reject |
| `POST /api/sops/runs/:id/cancel` | Cancel (honoured between nodes; an in-flight node finishes) |

Every transition is broadcast on SSE as `sop-update` for live UI, audited
(`sop.start`, `sop.node`, `sop.approve`, `sop.cancel`), and persisted to
`.harness/sops/runs/<runId>.json`.

## Failure and honesty rules

- A failed script with no `onFail` fails the run, naming the node and quoting
  its output.
- An agent node with no model available fails the run plainly - it never fakes
  a pass.
- Gate rejections with no `sendBackTo` fail the run and say so.
- Cancel during an in-flight node records the node's outcome but never lets the
  run continue or rework past the cancellation.

## Tests

`npm run sop:test` (20 checks, wired into `npm test`): gated flow, automated
preference at run and file level, rework edges + the bounded loop, send-back
and rejection from gates, agent nodes without a model, cancellation, listing,
and unknown-SOP errors.
