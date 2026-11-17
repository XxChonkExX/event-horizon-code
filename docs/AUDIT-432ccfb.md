# Audit response record — baseline 432ccfb, remediation f1d0c06

Reference for independent reviewers: this document maps the EH-001..EH-020 findings
from the first external audit to what changed in `f1d0c06`, what was intentionally
deferred, and where the known residuals live. Anchor new findings to `f1d0c06` or
later; do not re-report the items below without new evidence.

## Fixed in f1d0c06

| ID | Fix |
|----|-----|
| EH-001 | `fs:op` IPC uses `wsguard.contained()` (relative + realpath canonicalisation); sibling-prefix and symlink escapes rejected; sender origin confined to app windows; op allowlist; payload length checks |
| EH-002 | sender validation + allowlisted ops + runtime payload validation on `fs:op` and `edit:action`; `edit:action` restricted to copy/cut/paste/selectAll |
| EH-003/016 | global 4 MiB body guard + 60s socket timeout at the single server entry point; breach sends 413 and destroys the socket before any handler buffers |
| EH-005 | `runtime.json` written atomically (tmp+rename), 0600 perms (POSIX), pid liveness verified before attach |
| EH-007 | approval authority removed from tool arguments entirely: `runTool(..., { userApproved })`, set only by the HTTP user channel or the session auto-approve opt-in; `args.approved` is stripped before dispatch |
| EH-009 | `/api/files` uses the shared guard |
| EH-010 | `POST /api/events/ticket` exchanges Basic auth for a single-use 60s ticket; EventSource URLs carry tickets, never the password; `?auth=` retained for compatibility |
| EH-011 | `ls` containment via the shared guard (sibling-prefix bug closed) |
| EH-012 | `grep` validates the search root for ripgrep AND the JS fallback |
| EH-013 | project memory writes go through the guard with a 2 KB entry cap |
| EH-015 | AfterImage src resolution: `EH_ENGRAM_SRC` → sibling checkout → in-workspace copy; no machine-specific absolute paths |
| EH-017 | `getAuditPath()` is the single source; viewer honours `EH_AUDIT_LOG` |
| EH-018 | bash audit notes carry shape metadata (`bash 143ch argv=2`), not command text |
| EH-019 | `/api/logs/audit` uses a bounded 512 KB tail read; response is `{health, entries}` (shape change — no in-repo consumer) |
| A | `postinstall` failure prints a loud warning instead of `|| true` |
| B | `npm test` now includes `test:integration` (9-check end-to-end smoke) |

## Addressed with stated limitations

- **EH-004**: `wsguard` canonicalises through realpath for existing paths; validation
  and use remain separate operations, so TOCTOU is reduced, not eliminated. Stated in
  `src/server/wsguard.ts` header.
- **EH-006**: rotation (5 MB), retained last-error, `auditHealth()` added. Writes are
  `appendFileSync` on a single-threaded loop (serialized by construction). Fail-closed
  for security-sensitive ops deliberately NOT adopted — a disk-full condition must not
  stop the agent; health is observable instead.
- **EH-014**: no silent host fallback already enforced and tested; review tier documented
  as trusted-only (`node:vm` is not a hostile-code boundary). Heavier supervision
  (resource quotas, watchdog) is coupled to vendoring the `sbx` microVM — post-alpha.

## Deferred (tracked, not forgotten)

- **EH-008 (HIGH)**: config-vs-worktree authority divergence → requires the
  `ToolExecutionContext` refactor. Residual risk is bounded: permissions are currently
  global (one `.harness/config.json` per process), so there is no per-worktree
  permission divergence to exploit; path handling is now guarded. Post-alpha milestone.
- **EH-020 (partial)**: session `worktree` values are existence-validated and now
  actually used by the renderer (not session ids), but full workspace authorization
  policy lands with the same refactor.

## Known machine-level issue (out of code scope)

- Windows compositor can present a stale frame under heavy GPU load; a single click
  recovers. All in-app triggers found so far are removed (native dialogs, fullscreen
  overlays, new-window-from-+). Details: `docs/GPU.md`.

## Verification at f1d0c06

- `npm run typecheck` — clean.
- `npm test` — exit 0, 8 suites ALL PASS **plus** the 9-check end-to-end smoke.
- `npm run pack:dir` — verified earlier at 432ccfb (engine staged 10 files SHA-verified;
  RC launched from `win-unpacked` with its own runtime; see `docs/RELEASE.md` §3).

## Suggested focus for the next sweep

1. `agentLoop.ts` cancellation/retry/budget paths (audit §15) — the loop is 358 lines.
2. `wsguard.ts` bypass hunting — try to break containment (symlinks, case tricks,
   unc paths, junctions).
3. `session-windows` / popout IPC surface — same sender validation as fs:op.
4. Store concurrency: concurrent sessions writing the same SQLite rows.
5. Fresh eyes on `http.ts` (1100+ lines) — route-by-route review for anything the
  byte-guard does not cover.

---

# Sweep 2 response - Grok 4.6, 7 findings (baseline f1d0c06)

| Finding | Triage | Action |
|---|---|---|
| 1. checkAuth length-sensitive | Accepted | Length check before timingSafeEqual, first-colon split (passwords containing ':' now valid), empty-password rejection |
| 2. bash tool (quotes/allowlist) | Partially accepted | Quoted-argv split adopted; credential regex already matched their proposal; allowlist implemented as config-driven (tools.bash.allowlist in .harness/config.json) rather than hardcoded - policy stays the user's; the permission gate remains the primary boundary. Redirect/pipe note: execFile never interprets shell metacharacters - they arrive as literal argv, which is safer, not less safe |
| 3. wsguard Windows quirks | Documented, not code-changed | UNC/device/absolute inputs already rejected via path.isAbsolute; case-insensitivity relies on the realpath canonical check; trailing-dot/space names noted as a Windows quirk to watch |
| 4. agent-loop cancellation | Already existed between steps; extended | Added per-tool-call cancel check - a cancel between tool calls pushes a (cancelled before this tool executed) tool message (keeps the conversation valid) and stops the run before the next execution |
| 5. store transactions | Accepted | saveMessages, deleteSession, forkSession wrapped in db.transaction (crash-safe; concurrent-process safe on the shared WAL file) |
| 6. CORS origin reflection | Accepted | Only localhost/127.0.0.1/null origins reflected; everything else gets no CORS headers |
| 7. monolith split | Deferred | Post-alpha refactor, agreed - the audit itself says to wait until remediation stabilizes |
| Event ticket purge | Accepted | Expired tickets purged lazily on issue when the map exceeds 64 entries |
| resolveWorktree fail-closed | Deferred | cwd fallback is load-bearing for session boot; a fail-closed variant lands with the worktree-plumbing refactor |
| Adversarial tests | Accepted | scripts/test-wsguard.ts - 11 checks incl. live junction escape rejection; wired into npm test |

Verified: npm run typecheck clean; npm test exit=0 (10 stages incl. wsguard 11/11 + smoke).
