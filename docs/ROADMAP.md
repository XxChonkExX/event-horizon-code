# Event Horizon Code — Roadmap (sweep-5 strategic frame)

Design principle: **verifiable autonomy**. Not an agent that can do more things,
but an agent whose actions can be inspected, reproduced where possible,
interrupted, evaluated, and held accountable to evidence.

Three products, clean interfaces, independent responsibilities:

| Product | Role |
|---|---|
| **Event Horizon Code** (the Workbench) | The environment where humans and agents work on software together |
| **Event Horizon Runtime** (the Execution Platform) | Models, agents, tools, workflows, permissions, processes, persistence |
| **AgentWatch** (the Assurance Layer) | Independent monitoring, evidence, anomaly detection, informed decisions |

## What exists now (foundation)

- Local server as source of truth; Electron windows are projections (attach-first single runtime).
- Multi-window workbench: activity bar, Monaco + live LSP, PTY, panels, pop-outs, Session log manager.
- Agent loop: bounded steps, retries, context recovery, per-session serialization, cooperative cancel, **global operator pause**.
- Tool permission gates (allow/ask/deny + prefix patterns for MCP families), approval authority the model cannot grant, workspace containment (sibling/symlink/junction proof), bounded bodies.
- SOP engine (agent/script/gate nodes, rework, gated/automated, script-node approval with immutable reviewed command).
- Sessions/checkpoints/forks/compaction; profiles; memory + engram; sensory (TTS live, STT in the composer since 0.0.4a); MCP client.
- Assurance: wsguard adversarial tests, ACP security tests, 23-stage `npm test` incl. end-to-end smoke, audit log with rotation/health, release pipeline gated on tests + engine staging.
- Operator command surface: `/api/capabilities` (health-derived), `/api/runtime/pause`, `/api/approvals`.

## Phase 1 — Reliability foundation (next)

| Area | Scope |
|---|---|
| **Durable Agent Run** | First-class run entity (id, session, objective, plan/step, identity, tool/approval/result/error records, checkpoints, resources, disposition). Session = conversation; Run = work being performed. A run survives window close, restart, model switch. State machine: Planning → AwaitingApproval → Running → Cancelled → Checkpointed → Verifying → Completed → NeedsRepair → Failed. Execution timeline UI. |
| Recovery & cancellation | Per-step checkpoints + resume; cancellation tokens through every async op; idempotent mutating tools. |
| Runtime supervision | Lifecycle contract for every child (start/readiness/health/graceful/forced/restart, output capture, resource accounting): llama-server, MCP, LSP, PTY, AgentWatch, sandbox. |
| Release verification | Final sweep → version bump → `pack:dir` → RC checklist → SHA → tag. |

## Phase 2 — Coding intelligence (Verified Change Pipeline)

Patch-based editing with context validation and atomic application; pre/post diagnostic comparison (distinguish introduced errors from pre-existing); targeted test selection by changed files; diagnostic-driven bounded repair; Git checkpoint/rollback; change-impact analysis; **independent review agent** (separate from implementer; sees diff + tests, not private reasoning).

## Phase 3 — Multi-agent coordination (Mission Control)

Coordinator + bounded worker delegation (scoped objective, minimal authority, isolated context); inter-agent structured messaging; shared project awareness (who is editing what, agreed interfaces, blocked deps); worktree conflict detection; human arbitration; approval queue surfaced in UI. Start with 2 agents, not a swarm.

## Phase 4 — Agent assurance (AgentWatch evolution)

Findings bound to (worktree, revision hash, run id, file hash, rule version, acknowledgment identity); freshness enforcement via file-change events + risk-based rescan; behavioral profiles (coding discipline, security discipline, operational discipline, instruction integrity, honesty); temporal/sequence analysis (repeats of denied ops, credential-adjacent reads, post-approval protected-file writes); evidence-based assurance report with explicit coverage limits.

## Phase 5 — Ecosystem (integration registry)

Common contract: identity/version, capabilities, health, config, permissions, I/O contracts, audit events, resource limits, shutdown, failure/fallback. Unified Integrations panel. Candidates: DAP debugger, GitHub (issues/PR/review/CI), containers, read-only DB inspection, documentation knowledge graph, local notifications, OTLP export.

## Phase 6 — Advanced autonomy

Unattended missions with explicit scope + expiration; scheduled workflows; multi-agent experiments; configurable autonomous envelopes.

## Flagships

1. **Mission Control** — one operational view: sessions, runs, approvals, resources, worktree/git state, alerts, integration health, task outcomes.
2. **Independent Review Agent** — implementer / reviewer / verifier with independent evidence; none can approve its own work.
3. **Agent Forensics** — reconstruct a run: knowledge, attempts, tools, changes, divergence from plan.
4. **Model Crucible / Evaluation Lab** — identical tasks across models/prompts/configs; dimensions: task success, correctness, tool efficiency, reliability, honesty, security, autonomy, resource use. Never one aggregate score.
5. **Workflow Composer** — visual composition of agent/script/approval/verify/integration nodes.

## Scaffolded now (designs, not implemented)

| Item | Note |
|---|---|
| In-place session tabs | Shipped: switching is in-place (remounts Terminal/Monaco per session). Remaining polish: per-session editor tabs/drafts and the MemoryPanel session prop. |
| Linux/macOS engine staging | `prepare-engine.mjs` stages Windows binaries; per-platform file lists + verification are needed before multi-OS packaging. Release workflow is Windows-only by design. |
| Omarchy plugin | Scaffold in `integrations/omarchy/` (bar widget + session menu via the local runtime API). |
| App icon / code signing | Icon shipped (build/icon.png + .ico); the certificate is the remaining half - operator input required. |
| Password boundary | DONE: renderer holds no credential (IPC proxy + main-minted tickets). Residual: trusted-renderer XSS equals full app compromise (same for any local tool); mitigated by CSP + minimal bridge. |
| fs:op session-worktree binding | DONE: file ops anchor to the session's validated worktree. |
| MCP per-server permissions | DONE: prefix patterns (`mcp_server_*`) in `.harness/config.json` permissions; per-tool exact names already gated. |

## Deliberately avoided

- Not everything is an agent (deterministic ops stay deterministic).
- Agents never grant themselves permissions (authority is application-owned).
- Memory is never unquestioned truth (provenance, timestamps, correction paths).
- Autonomy ≠ quality; fewer approvals ≠ better performance.
- No giant plugin ecosystem before the integration contract stabilizes.
- AgentWatch is never an opaque trust score (evidence stays inspectable).
- Never sacrifice independent verification for speed.
