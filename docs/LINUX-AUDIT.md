# LINUX AUDIT — 2026-11-18 (alpha close-out pass)

Scope: formal first Linux pass over a source checkout on the alpha machine.
Windows remains the verified packaged target; this document records what now
works on Linux, what was fixed as a result of the pass, and what is still a
stated gap. Every claim below is command-backed or operator-confirmed.

## Environment

- Ubuntu 26.04.1 LTS, kernel 7.0.0, x86_64, GNOME on **native Wayland**
  (`wayland-0` socket; **no XWayland** in this session — X11 fallback paths
  are therefore untestable here).
- Node v22.23.5 (nvm), Electron 42.11.18, npm ci clean (366 packages,
  better-sqlite3 + @lydell/node-pty prebuilt for the Electron ABI; both
  verified loadable under plain Node as well).

## Verified working (evidence)

- `npm test`: 167 checks, exit=0 (typecheck, wsguard 14/14, acpsec 9/9, LSP,
  detonate, tool-search, SOP, sessions, memory, sensory, TTS, engram note,
  9-check e2e smoke). Re-run three times across the pass, all green.
- Headless runtime: `npm run serve` up in 1s; `/global/health`, `/api/models`,
  `/api/acp/session/new`, `/api/detonate/check` all green; `store=sqlite` in
  the audit log; clean stop, port freed, no orphaned processes.
- Desktop app from source: runtime spawn + attach-first manifest
  (`runtime.json` pid = Electron main pid), session restore (PTY terminal is a
  real `/bin/bash` via node-pty + `$SHELL` fallback, terminal.ts:71), LSP
  attach, native Wayland GPU process
  (`--ozone-platform=wayland --render-node-override=/dev/dri/renderD128`).
- Packaged `electron-builder --dir`: `dist/linux-unpacked` (424 MB) launches,
  spawns its own runtime, window reveals (see #48859 fix below), asar with
  native modules unpacked (`asarUnpack` **/*.node).
- Desktop integration: `npm run desktop:install` equivalent installed manually
  and then committed as a script — hicolor icons (256→32), `~/.local/share/
  applications/event-horizon-code.desktop` with `StartupWMClass=event-horizon-code`
  (Electron's Wayland app_id = package name), dock pin, operator-confirmed.

## Fixed as a result of this pass (all pushed)

1. **Display-less launch was a silent server-only zombie.** Electron 42 boots
   headless with no `DISPLAY`/`WAYLAND_DISPLAY`; the runtime works over curl
   and no window can ever exist, with zero warnings. Now `app.exit(1)` with a
   plain message pointing at the graphical session or `npm run serve`.
   (`src/main/index.ts`, RUNTIME.md updated.)
2. **Failed first renderer load left a permanently hidden window.** Windows
   are `show:false` and revealed on `ready-to-show`, which never fires when
   the first load fails. `hardenWindow`'s `did-fail-load` error page (added in
   254ff88) now calls `win.show()` — the diagnostic is actually visible.
3. **Healthy renderer, window still hidden — sporadically.** Upstream
   **Electron#48859**: on native Wayland `ready-to-show` can fail to fire even
   when the renderer loads fine (Chromium ozone GPU-timing bug, open against
   38–42.x, GPU-correlated, inconsistent — one launch shows, the identical
   relaunch does not). Workaround shipped the same way as FreeTube#8294 /
   chaiNNer#3351: reveal on `did-finish-load` when `ready-to-show` has not
   already done it (Linux-only check, first-wins `isVisible` guard; Windows/
   macOS keep the no-flash reveal; a warn line names the upstream issue).
4. **Engine port-conflict guard was Windows-only.** `startEngine` on Linux
   skipped the stale-listener check entirely (a stale llama-server would win
   the port while the new engine died on EADDRINUSE). `enginePortBusy()` keeps
   the PowerShell Listen check on win32 and probes with a TCP connect
   elsewhere (listener accepts → busy, ECONNREFUSED → free). Verified both
   ways live (busy=true against a live listener, false against a dead port).
5. **Packaged builds shipped no templates and no language packs.**
   `chatTemplates.ts` and `lsp.ts` look in `<execDir>/resources` and fall back
   to the process cwd — the user's arbitrary cwd in an installed app.
   `electron-builder.yml` now maps `resources/templates` and `languages` into
   extraResources (pure addition; 568K + 256K).
6. **App icon + launcher.** `build/icon.png` (event-horizon artwork, doubles
   as the electron-builder icon — closes the "default Electron icon" known
   issue) and `scripts/install-linux-desktop.mjs` (`npm run desktop:install`,
   idempotent, `--uninstall` supported).

## Diagnoses that turned out wrong (recorded so nobody re-chases them)

- "ELECTRON_RENDERER_URL missing in dev" — false. `/proc/<pid>/environ` of a
  running Electron process is scrubbed by Chromium after startup; reading it
  reported the variable absent when it was not. The dev-mode hidden windows
  were Electron#48859, same as the built app. No dev-mode env bug exists.
  (Corollary: do not trust environ reads of live Chromium processes on this
  box — the failure mode costs an hour.)

## Known gaps / deferred (stated, not hidden)

- **Engine staging for Linux pack is roadmap** (README, RELEASE.md):
  `pack`/`pack:dir` chain `prepare:engine`, which fails loudly without
  `EH_ENGINE_SRC` pointing at a Linux chonkllama build (by design — never
  package silently engine-less). `electron-builder --dir` without staging is
  the local alpha route; at runtime the engine lane then refuses plainly.
- **AppImage / deb / rpm targets not yet exercised** — `--dir` only. The
  builder config already declares them; next pass should build and smoke each.
- **Screenshot tool remains Windows-only** (`tools.ts` states it plainly in
  the tool output). A Linux lane (grim/portal) is roadmap; not faked here.
- **Detonation lane**: no `sbx` on this box — refuses plainly (by design).
- **Speech sidecars absent** (whisper-cli, piper, llama-tts): status/doctor
  report absence honestly; TTS tests pass against the stated fallbacks.
- **Model lane untested end-to-end on Linux**: no `llama-server` binary and no
  Ollama on this machine. Router ladder resolution is covered by tests; a live
  inference run needs a Linux engine build (`EH_ENGINE_SRC`) or Ollama.
- **`StartupWMClass` = package name** assumption (Wayland app_id) — verified
  on GNOME 49/Electron 42 here; re-check on KDE at some point.
- Multi-instance: second `npm run dev` while the packaged app runs attaches to
  the same runtime by design (attach-first); no two-servers-one-database state
  observed at any point in the pass.

## Handoff to the Windows pass

Everything above is on `main` (see `git log` for the fix commits). The
Windows session should: re-verify `pack` end-to-end now that extraResources
gained templates/languages (should be additive), spot-check the #48859
workaround is a no-op there (`isVisible` guard means Windows never logs the
reveal line), and then run agent-run testing with the chonkllama engine.
