# AgentWatch integration — game plan (not wired)

> AgentWatch: https://github.com/XxChonkExX/AgentWatch — "A Tool-kit to monitor, diagnose the disposition, alignment, safety and working habits of your Agential Staff. Checks agential email, workspaces for malware/scripts/virii/goop, obfuscation checks, all performed locally — no clouds and the User is the final arbiter."

Event Horizon Code does NOT import or call AgentWatch in this phase. This doc is the plan for optional integration as a deterministic line-manager.

## AgentWatch today (M0-M4)

- Hash-chained ledger (`aw ledger init/verify/anchor`). Anchoring is manual to off-host media.
- Sweepers: filesystem + mail. Rules AW-U001..U004 (unicode), AW-N001 (NUL), AW-F001..F003 (ADS, entropy, magic mismatch), AW-S001 (obfuscation), AW-C001 (covert whitespace), AW-M001..M003 (signatures: builtin, ClamAV/YARA, open .hdb/.hsb/.ndb in signatures/), AW-P001..P005 (runtime posture: ports, connections, processes, drivers), AW-R001 (ledger mutation), AW-T001..T003 (thinking/containment leak tokens, prompt-injection, concealment).
- Runtime posture snapshots (`aw snapshot` / `aw posture --baseline`), backend-locked diff (psutil / PowerShell / /proc). Cross-backend diff refused.
- Canary tokens (`aw canary plant/check`), loop detection (`aw ledger loops` -> AW-P007), OTLP ingest (`aw otel serve :4318` -> ledger).
- Probe packs: agentic_behavior, workplace/HR review, guardrail-slip under obfuscation. Deterministic gates + coupled-metric anti-gaming. Verdict is human's; gates only rank.
- CLI + local FastAPI dashboard on 127.0.0.1:8018. No cloud.

Doctrine: Lane A (deterministic, bit-for-bit, rule + version hash + falsifier) may condemn. Lane B (advisory, model-stamped) may only rank. User is final arbiter.

## How it maps to Event Horizon

Event Horizon clean vs detonation already splits trust. AgentWatch is the deterministic layer between them.

```
Agent + Tool output (untrusted)
  -> Lane A sweep (filesystem/mail/runtime)   <- AgentWatch deterministic engine
  -> Lane B ranking (probe scores, posture diff)
  -> Human verdict (UI: approve / block / quarantine)
  -> Detonation if unclean (our detonate lane)
  -> Clean worktree only if cleared
```

Concrete hooks (future, not implemented):

1. **Workspace sweep on session start.** EHC `LspManager.spawnForFile` already creates a worktree. Before LSP spawn, call `aw sweep <worktree> --ledger ~/.eventhorizon/aw-ledger --json`. If AW-M*/AW-R001 critical: block spawn, show report in ToolchainDoctor panel, route to detonate. Deterministic, reproduces bit-for-bit.
2. **Mailbox sweep.** EHC mail mirror under `~/.eventhorizon/mail/` (agent-to-agent email). Same sweep entrypoint as filesystem. Catches obfuscated payloads in message bodies.
3. **Runtime posture baseline in UI.** ToolchainDoctor already runs checks. Add AgentWatch panel: `aw snapshot` baseline per host, `aw posture --baseline` diff. Shows new ports (AW-P001), new processes (AW-P003/P004), new drivers (AW-P005). Cross-backend diff refused — falls back to "snapshot unavailable" with reason, never a silent pass.
4. **Ledger as audit trail.** Our `src/server/audit.ts` writes `audit.jsonl`. AgentWatch ledger is hash-chained and anchored. Integration: `aw ledger` remains the system of record for findings; EHC `audit.jsonl` remains the system of record for tool calls. One write, two ledgers, never merge semantics. UI shows both side-by-side.
5. **Disposition / alignment probes.** Probe packs (agentic_behavior, workplace, guardrail-slip) already measure disposition. In EHC, probe runs are opt-in per worktree: `POST /api/agentwatch/probe` with `--target-url` + `--model`. Score output is JSON; gates rank, human decides. No auto-merge based on probe score.
6. **Deterministic line-manager (optional).** If enabled in config (`"agentwatch": {"lineManager": true}`), EHC blocks `edit`/`bash` in a worktree when sweep returns high/critical unacknowledged. UI shows findings, user clicks Approve / Quarantine / Detonate. No LLM judge. The manager does not infer intent; it enforces prior sweep state.
7. **Canaries + loops.** Canary files planted in sensitive worktrees; `aw canary check` on session start. `aw ledger loops` detects stuck-agent patterns (AW-P007) and surfaces in session list as "loop suspected — human review".

## Non-goals

- No cloud. No telemetry. AgentWatch is already local/stdlib-only.
- No auto-quarantine without human click. Lane A may condemn, but EHC still asks. User is final arbiter.
- No training on probe data. Probe transcripts stay in ledger, never fed back into engram packs without explicit user registration.

## Licensing

- AgentWatch — MIT, https://github.com/XxChonkExX/AgentWatch. Same author. Add `NOTICE.md` row when integrated.
- Signature databases: user-dropped ClamAV .hdb/.hsb/.ndb in `signatures/` are not committed. Document license per file in manifest.

## Phasing

- Phase A (now): this doc only. No code, no dependency.
- Phase B: read-only sweep panel in ToolchainDoctor UI, subprocess call to `aw sweep --json`, no gating. Measure false-positive rate on real worktrees.
- Phase C: mailbox sweep + posture diff. Baseline snapshot stored under `~/.eventhorizon/aw-ledger/`.
- Phase D: opt-in line-manager gating with user approval UI. Behind config flag, default off.
- Phase E: probe packs integration + OTLP ingest for agent spans.

GPU/CPU note: sweeps are filesystem-bound, stdlib Python, no GPU. Safe while CodeRed-418 trains on B70. Posture snapshots on Windows use PowerShell; on Linux use `/proc` backend.
