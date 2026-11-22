# External source audit (ChatGPT, 0.0.3a) — triage + remediation record

Source-level pre-release audit received 2026-11-22. Overall verdict 7.7/10
pre-release; "make 0.0.3 the reliability and security consolidation milestone."
Every finding below is actioned with a commit + regression test, or explicitly
scheduled. Companion to `docs/AUDIT-432ccfb.md` (internal sweeps).

| # | Finding (audit severity) | Status | Where |
|---|---|---|---|
| 1 | Detonation baseline captured AFTER execution (P0 / release blocker) | **FIXED** | `tools.ts`: baseline precedes `runDetonate`; refusal when no baseline can be established. Regression: `detonate:test` §10 (baseline-before-change detects; post-change baseline demonstrated blind) |
| 2 | Tool-call replay loses protocol metadata (High) | **FIXED** | `store.ts`: messages gain `toolCalls`/`toolCallId`/`toolName` (columns + migration; forks copy them); `agentLoop` persists via `toStored` and replays via `toChat`. Regression: `sessions:test` reopen + fork roundtrip |
| 3 | Cancellation recorded as failure at the final tool boundary (Medium) | **FIXED** | `agentLoop`: final cancellation disposition check before the exhaustion path; run disposes `cancelled` |
| 4 | Tool-call count unbounded per turn (Medium) | **FIXED** | `MAX_TOOL_CALLS_PER_TURN = 24`; distinct failed disposition (`budget.tool` timeline event) |
| 5 | SOP agent nodes never received prior-node context (functional defect) | **FIXED** | `sop.ts`: `agentNodePrompt()` attaches prior outputs as labelled UNTRUSTED DATA. Regression: `sop:test` §13 |
| 6 | webfetch SSRF surface (High) | **FIXED** | `tools.ts`: `assertFetchableUrl` — private/reserved ranges, metadata, local naming, resolved-address validation; redirects re-validated per hop; 2MB bounded body read. Regression: `webfetch:test` (24 checks) |
| 7 | Credential denylist gaps (.ssh, cloud, npm/docker, key formats) | **FIXED** | `tools.ts` denylist + `.ssh/*` rule. Regression: `detonate:test` §9 + `webfetch:test`. Boundary note kept: interpreter-constructed paths are out of regex reach — isolation is the real fix |
| 8 | Unbounded read/edit memory exposure (Medium) | **FIXED** | read/edit: regular-file check + 2MB cap BEFORE the read, stated refusal |
| 9 | MCP init failure leaks the child process (Medium) | **FIXED** | `mcp.ts`: init/tools-list failures invoke `failServer` (child killed, pending settled) before rethrow |
| 10 | Session worktree lost across restarts (Medium) | **FIXED** | prompt path falls back to the session's persisted worktree; `session/load` restores the map and returns `worktree` |
| 11 | Audit log "hash" was reversible base64 (Low) | **FIXED** | `sop.ts`: sha256 digest prefix |
| 12 | Version markers stale (preload/http 0.0.2) + README Node 20 + dev-command typo | **FIXED** | `src/shared/version.ts` single constant (preload + http import); Node 22+; typo fixed; CHANGELOG 0.0.3a entry |
| 13 | Quarantine coverage: git-ignored / external files (High, architectural) | **FIXED (9f70132)** | fs-snapshot quarantine layer: bounded sha256 walk of the worktree before + after; catches ignored-file changes git cannot see (regression asserted in `detonate:test` §10). External-of-worktree changes remain out of any detector's scope by definition - the guest never receives the host worktree at all (see 14) |
| 14 | Sandbox artifact delivery + process-tree termination + policy env to guest (P1s) | **FIXED (9f70132)** | Namespace runner (`ns` backend, default): artifact DELIVERED into the guest copy (`/tmp/ehc-detonate/<runid>/`), mount+pid+net namespaces (host drives detached — guest sees 0 files under /mnt/c; loopback-only network verified from inside the guest), privilege drop to non-root with a minimal constructed env, pkill sweep + pgrep CONFIRMATION of tree termination. Per-mechanic verification flags on the result; the run fails honestly if any mechanic cannot be verified. sbx remains selectable via config (`detonate.backend: "sbx"`) |
| 15 | .harness/config.json machine-specific paths in repo | **SCHEDULED** | split into example + gitignored local; touches permission defaults — planned with fresh-clone testing |
| 16 | TOCTOU in wsguard (known limitation) | **SCHEDULED** | descriptor-relative operations noted; current mitigations documented in `wsguard.ts` |
| 17 | SECURITY.md keychain claim vs plain-JSON BYOK | **TODO (docs)** | correct the doc or implement keychain — next docs pass |
| 18 | http.ts/tools.ts/agentLoop.ts module size | **NOTE** | split incrementally AFTER security work (audit agrees with deferral) |

## Preserved by design (audit "do not rewrite" list)

Electron security architecture (proxy + trusted-renderer + tickets), SQLite
persistence with per-session locks, SOP architecture, AfterImage integration,
AgentWatch determinism, bounded execution. The audit explicitly endorses the
three-product split (workbench / runtime / AgentWatch).

## Testing added with this remediation

- `webfetch:test` (new stage): private-address classifier, literal/named
  refusals, bounded read, denylist extensions.
- `detonate:test` §9-10: extended denylist; quarantine ordering regression
  (baseline-before-change detects; post-change baseline demonstrated blind;
  ignored-file limitation asserted as documented).
- `sessions:test`: tool-call protocol survives reopen AND fork.
- `sop:test` §13: agent-node prompt carries prior output, untrusted label,
  task, node instruction.
