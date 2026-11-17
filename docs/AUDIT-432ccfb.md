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

---

# Sweep 3 response - GPT deep audit, 10 findings (baseline 1cab088)

Triage at commit: sweep-3 remediation. All Priority-0 items from the audit's own
remediation order are implemented; the full ACP integration suite (finding 13) is
partially adopted (env + credential tests added; the full server-boot integration
suite is the remaining piece).

| Finding | Triage | Action |
|---|---|---|
| 2/11 (CRITICAL) ACP fs/read_text_file escapes workspace, bypasses credential policy | Confirmed - raw readFileSync on params.path | Rewritten: session worktree base, safePath (containment + credential policy in one rule), stat isFile, 200 KB cap, audit both directions, 403/413/404 semantics |
| 3 (CRITICAL) ACP terminal execution | Confirmed | `EH_ACP_TERMINAL=1` gate, denied by default with audit trail; server-owned approval grants remain post-alpha |
| 4 request_permission echo | Confirmed, already neutralised | Nothing treats the echo as authority since the EH-007 fix (runTool opts.userApproved only); endpoint marked advisory in code + audit |
| 5 IPC trust boundary | Confirmed | `isTrustedRenderer` (main-frame, file:// packaged path, dev vite origin) applied to runtime:info, dialog:pickFolder, window:popout (kind allowlist), edit:action, fs:op; will-navigate + window.open denied in hardenWindow |
| 6 wsguard race | Tests extended | Case/dangling/retarget documented; race itself remains the known stated limitation |
| 7 terminal ID collisions | Confirmed | `crypto.randomUUID()` for term_ and acpterm_ ids |
| 8 terminal env injection | Confirmed | `sanitizeTerminalEnv`: blocked loader/resolution keys (NODE_OPTIONS, LD_PRELOAD, ELECTRON_RUN_AS_NODE, ...), key/value validation, tested |
| 9 request-controlled autoApprove | Deferred with rationale | The parameter originates from the renderer's operator checkbox; the credential already confers direct tool-call authority via /api/tools/call, so removal does not reduce attacker capability. Documented in http.ts + here; server-owned grants post-alpha |
| 10 session worktree continuity | Confirmed defect | Omitted worktree now means the session's assigned workspace; explicit worktree still allowed; assignment recorded per session |
| 12 detonation doc divergence | Confirmed | DETONATION.md gained an implemented/planned guarantees table; unverified sbx rows marked as policy-plus-best-effort, not a demonstrated sandbox |
| 17/18 (CRITICAL) node:vm clean tier | Confirmed | Replaced with a DECLARATIVE read-only batch (1-16 read/ls/grep/glob ops, 100 KB cap). No model-written JavaScript executes in-process; arbitrary JS remains only in the sbx lanes. Tool description updated |
| 19 detonation artifact delivery | Confirmed divergence | artifactPath is first-class on the plan; unconditional artifact cleanup; delivery verification deferred until sbx is vendored (documented in DETONATION.md) |
| 20 verify permission | Accepted | verify moved to permission: ask; description states repository code is untrusted |
| 21 memory injection | Accepted | Memory/AGENTS.md reads go through wsguard; content framed as UNTRUSTED WORKSPACE DATA with explicit anti-injection instructions |
| 22 dangling-symlink containment bypass | Confirmed - real escape | contained() rewritten with lstat probing (catches dangling links), realpath fail-closed; regression tests: dangling link + dangling child both rejected |
| 23 canonical credential bypass | Confirmed - real escape | safePath re-checks the credential policy against the canonical path after containment (symlink alias "harmless-config.json" -> .env now refused); regression test added |
| 24 grep walker follows symlinks | Confirmed | Walker skips symlinks entirely; per-file revalidation documented as future defense |
| 25 cross-session memory | Confirmed | remember/todo session identity is application-established (opts.sessionId wins over model args); the model cannot write instructions into another session |
| 26 SOP script-node approval | Confirmed | Gated runs now pause at script nodes with the exact pending command recorded; approval authorizes that immutable command through the existing approve endpoint; rejection fails the run |
| 27 quarantine failure | Confirmed | Quarantine failure now marks the detonation run FAILED with a stated cause |
| 13 regression tests | Partially adopted | sanitizeTerminalEnv + credential-alias + dangling-symlink tests added; full ACP server-boot integration suite deferred to the next pass |

Verified: npm run typecheck clean; npm test exit=0 (11 stages incl. wsguard 11/11 + acpsec + smoke).

---

# Sweep 4 response - GPT continuation: MCP / Storage / Electron (baseline f1d0c06+)

| Finding | Priority | Triage | Action |
|---|---|---|---|
| Fork message PK collision (repeated forks of one parent collide on fk_<seq>, UNIQUE constraint) | P1 | Confirmed - present in our own audit log | Fork ids embed the new session id (fk_<newId>_<seq>); wrapped in a transaction |
| SQLite failures silently fall back to volatile memory | P1 | Confirmed | initStore logs a FATAL-level warning naming the cause; memory mode remains for availability but is now loud |
| Master password exposed to renderer JS via runtime:info | P0 | Architectural decision, deferred with rationale | The renderer IS the API client (SSE, file ops, streaming); a compromised renderer already equals full app compromise, and the credential never leaves the machine (localhost bind, tickets, CSP). Server-side auth proxy = post-alpha refactor. Password never appears in logs or URLs |
| IPC sender checks incomplete | P1 | Partially confirmed | isTrustedRenderer now also guards window:nudge and window:grow |
| MCP JSON-RPC buffer unbounded | P1 | Accepted | 2 MiB buffer cap + 1 MiB per-line cap; breach fails the server (kill + settle pending) |
| MCP exit/startup failure leaves pending promises | P2 | Accepted | rejectPending settles all outstanding requests exactly once on exit/error; failServer kills and tears down |
| Concurrent turns overwrite session history | P2 | Accepted | Per-session in-process lock serializes every turn through runAgentTurn (HTTP + SOP agent nodes) |
| No FK constraints | P2 | Deferred | Schema change + migration on a live user database - documented for alpha migration notes |
| fs:op should bind to a validated session worktree | P2 | Deferred | Worktree-plumbing milestone; root deletion/renaming already refused |
| Memory backend lifecycle differs | P3 | Deferred (documented) | Fallback is loud now; lifecycle parity post-alpha |
| MCP per-server permissions / name validation | P3 | Deferred | Servers are user-configured in .harness/config.json |

Smoke-test hardening: prompt fetch retries once and dumps the server output tail plus liveness on failure (one unexplained prompt death in a previous run is now diagnosable; clean-environment rerun fully green).

Verification: npm run typecheck clean; npm test exit=0 - 12 stages (wsguard 14/14, acpsec 9/9, 8 suites ALL PASS, smoke green) on a clean environment with no other EHC process holding the database.

---

# Sweep 5 response - final pre-release audit, 10+ findings (baseline 3e0500c)

## Release-critical - all fixed

| Finding | Fix |
|---|---|
| P1 SOP approval executes the CURRENT node command, not the reviewed snapshot | approval now runs the approved COMMAND SNAPSHOT captured at pause time; a SOP edited while waiting cannot change what executes; SOP-deleted-while-waiting fails the run instead of executing |
| P1 run_js tool schema declared ops as a STRING (interface/implementation mismatch - my regression from the declarative-batch change) | proper JSON Schema: array 1..16, items with op enum + path/pattern; aggregate ok = every operation succeeded |
| P1 detonation artifact delivery incomplete | stated plainly: plan steps rewritten as INTENDED-pipeline, artifactPath marked metadata-only, agentTools description says delivery is not yet implemented; sbx absence still refuses the lane. Full delivery+integration-test remains gated on vendoring sbx |
| P1 release workflow packages an EMPTY engine (no prepare:engine step) | release.yml rewritten: test job (full npm test) gates the build; build job Windows-only (staging is Windows-only today), downloads the pinned engine from ENGINE_URL secret, FAILS the job if unset or if llama-server.exe is missing, then stages + SHA-verifies before packaging |
| P1 EventSource migration incomplete (Terminal.tsx + MonacoMount.tsx still used auth=) | both migrated to the single-use ticket exchange; authQuery() removed |

## Additional fixes

- P2 terminal env: PATH and PATHEXT added to the blocked override set (executable resolution is no longer caller-influenceable)
- P2 detonation quarantine: pre-execution baseline capture + after-vs-before comparison (pre-existing dirty files can no longer fake pass/fail; content-hash drift on dirty files is detected)
- P2 detonation artifact name: unpredictable (UUID) + exclusive creation
- P2 MCP env: configured values may not override PATH/PATHEXT/NODE_OPTIONS/ELECTRON_RUN_AS_NODE; key/value shape validated
- P3 run_js aggregate success folded into the schema fix

## UI/UX regression check - responded

- Command palette removal: intentional (compositor trigger; first confirmed splay cause). A non-overlay in-page launcher may return post-alpha - recorded as roadmap.
- Header branding restored: the strip now carries the Event Horizon label again.
- Status bar literal worktree fixed: it now displays the session's ACTUAL worktree directory.

## Pipeline findings - responded

- CI now runs the FULL npm test suite (ubuntu, plain npm ci so native modules install).
- Release workflow: test job gates the build; engine staging fails the job loudly when the pinned source is not configured.
- Packaging narrowed to Windows (the only verified target) - Linux/macOS remain roadmap with the engine-staging work.

## Deferred (unchanged, documented)

- runtime:info still returns the master password to the trusted renderer (XSS-in-trusted-renderer residual) - main-process API proxy is post-alpha.
- fs:op anchored to process.cwd() rather than a session worktree - worktree-plumbing milestone.
- MCP per-server permissions and name validation - documented.

## Verification

npm run typecheck clean. npm test exit=0 - 12 stages (wsguard 14/14 incl. dangling-symlink + credential-alias, acpsec 9/9, 8 suites ALL PASS, smoke green) on a clean environment.
