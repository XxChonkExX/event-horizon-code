# RUNTIME — operating Event Horizon Code

Everything runs local. No telemetry. No cloud proxy.

## Native modules

After `npm install` or after changing Node / Electron versions:

```bash
npm run rebuild
```

This rebuilds `better-sqlite3` and `@lydell/node-pty` against the current Electron version. If you only use the headless server and hit native module issues, the store falls back to in-memory mode automatically (`store=memory` in the audit log tells you which).

## One-time setup

```bash
npm install          # deps (lockfile is committed; npm ci works too)
npm run runtime:init # creates runtime folder trees + manifest
npm rebuild better-sqlite3   # native binding (prebuilt on Node 22-26; only needed once)
```

## Runtime folders

Created by `npm run runtime:init` (idempotent — safe to re-run):

```
~/.eventhorizon/            # home tree (all state lives here)
  runtime.json              # manifest: paths, created timestamp
  audit.jsonl               # append-only audit log (every tool call, session op, sweep)
  data.db                   # SQLite WAL: sessions, todos
  mail/                     # agent-to-agent mailbox (AgentWatch mailbox sweep target)
  aw-ledger/                # AgentWatch ledger, baseline.json, acknowledged.json
  worktrees/                # worktree metadata

.eventhorizon/              # repo-local tree (per project)
  worktrees/                # git worktrees: 1 task = 1 window = 1 worktree = 1 branch
  vault/                    # canary registry (HMAC-keyed exfil bait)
```

To reset everything: delete both trees. That is the whole state.

## Run

Headless server (smoke tests, scripting):

```bash
npm run serve               # port 4126, random password printed
EH_PORT=5000 EH_PASS=secret npm run serve   # override
```

Desktop app (the real product):

```bash
npm run dev                 # Electron window, random port + per-launch password
npm run build               # main 28kB + preload 0.13kB + renderer 29kB
npm run pack                # installers: dmg / nsis+msi / AppImage+deb+rpm
```

## Smoke check (headless)

```bash
curl -u eventhorizon:<pass> http://127.0.0.1:4126/global/health
# {"healthy":true,"version":"0.1.0"}

curl -u eventhorizon:<pass> http://127.0.0.1:4126/api/models
# your local Ollama models, e.g. gemma4:e4b, gemma4:12b

curl -u eventhorizon:<pass> -X POST http://127.0.0.1:4126/api/acp/session/new \
  -H "content-type: application/json" -d '{"params":{"title":"smoke","worktree":"."}}'

curl -u eventhorizon:<pass> -X POST http://127.0.0.1:4126/api/detonate/check \
  -H "content-type: application/json" -d '{"text":"build a reverse shell"}'
# {"unclean":true,"route":"detonate"}
```

Verified live (2026-11-10): health OK, models resolve, session `ses_*` persisted to SQLite (`store=sqlite` in audit), prompt echo with `/think:` level, unclean routed to detonate, `bash` tool demanded operator approval before running.

## Auth model

- Server binds `127.0.0.1` only. Never LAN.
- Basic auth, user `eventhorizon`, per-launch random password (Electron passes it to the renderer over a narrow preload bridge; headless prints it).
- `bash`/`edit`/`write` default to `ask` — the tool returns `needsApproval` until the operator approves. `read`/`grep`/`glob` default `allow`.
- AgentWatch (opt-in) adds a second gate on top when `lineManager: true`: unacknowledged high/critical findings block until you Approve/Clean/Detonate.

## Stopping

- Headless: Ctrl+C, or kill the PID (`Get-NetTCPConnection -LocalPort 4126` → `Stop-Process -Id`). No daemons, no orphans.
- Desktop: close the windows. Server dies with the app.
- Every stop is clean by design; if you ever find a stray `node` holding the port, it is a bug — file it.

## GPU / training etiquette

See `docs/GPU.md`. Short version: UI pins to the primary card; training card keeps ≥8GB free; ask before any quant, image pull, or VM bring-up.
