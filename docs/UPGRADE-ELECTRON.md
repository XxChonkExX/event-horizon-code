# Upgrading Electron — runbook (42 → 45)

**EXECUTED 2026-11-27.** `electron 45.5.0` (exact pin; was `^42.0.0`); `npm run typecheck`; **`npm test` 25 stages / 761 checks + 14 smoke ALL PASS on Electron 45.5.0** (smoke runs under the new binary incl. `better-sqlite3` + `node-pty`); `npm run build`; real-window **permission matrix ALL PASS** (clipboard read/write + mic granted, camera denied, **screen-capture `display-capture` refused**, editor + terminal, no overflow; **Chromium 156.0.8078.109**); **approvals** real-window run; **hardened-browser** real-window run; **Sensors/Radar/one-switch** real-window `ALL PASS`; **`secrets:test:electron` ALL PASS**; **native rebuild `electron-builder install-app-deps` → `better-sqlite3` + `node-pty` completed** (no source change). Original `0.0.5a` was cut on Electron 42; this upgrade is on `main`, not in `0.0.5a`. `docs/SPATIAL-XR.md` re-measured `navigator.xr` on 45.5.0.

**One toolchain note discovered:** npm 11.17 has **`allow-scripts`**; a fresh `npm install electron@45.5.0` does **not** run Electron's `postinstall` (`install.js`, which downloads `node_modules/electron/dist`) nor this package's `postinstall`, and prints `npm approve-scripts`. **Dev-time only** (nothing here changes the app's own "nothing downloads unless you click" runtime rule; the user asked for this upgrade). Recovery: `npm approve-scripts electron`, then `node node_modules/electron/install.js`, then `npx electron-builder install-app-deps`. **`npm ci` on a lockfile already containing 45.5.0 + `allowScripts` is the clean path.**

---

**Why:** Electron 42 reached end of life on **2026-10-20** (no security fixes since; `42.11.18` was the final release). Supported majors after the upgrade: **45** (until 2027-04-27); **46 stable 2027-01-05** (Node 26 — native-module check); **45 EOL 2027-04-27**; `release-mac.yml` `macos-latest` ≥13.

**Target:** `electron@45.5.0` — Chromium 156, Node 24.22. Both native modules are N-API; rebuild ran clean.

**When:** in a headroom window (training paused; ~6 GB is enough; the window buys the real-window matrix without GPU contention). Budget 45–60 minutes.

## What changes 42 → 45 that touches this app

| Change | Affects us | Handling |
|---|---|---|
| **45:** screen capture is reported as `display-capture` in the permission handlers, no longer as `media` with no types | **Yes — posture.** Our "anything not media is granted to our windows" rule would have silently allowed screen capture (it was refused only by accident before) | **Done before the upgrade** (`src/main/index.ts`, `NEVER` set): `display-capture` is refused explicitly on every window. Nothing in the app captures the screen through the page. |
| 44: `clipboard` module removed from renderers; main's API is Promise-based | No | No use of the `clipboard` module anywhere (copy/paste goes through `webContents.copy/paste/selectAll` from the preload bridge) |
| 44: ANGLE statically linked (`libEGL`/`libGLESv2` no longer shipped) | No | The engine's `ggml-vulkan.dll` is independent of Chromium's ANGLE |
| 44: macOS 12 dropped; 13+ required | Docs only | macOS floor is now 13 (Ventura) |
| 44: 32-bit builds removed | No | Never shipped ia32/armv7l |
| 44: `net.request` rejects `document`/`frame` destinations without navigate mode | No | The runtime uses Node's fetch (undici), not Electron `net` |
| 43: dialogs default to the Downloads folder when `defaultPath` is omitted | Cosmetic | The two folder pickers just open elsewhere; pass `defaultPath` later if it bothers anyone |
| 43: Linux frameless windows get rounded corners; WCO layout | No | No frameless/WCO windows |
| 44.3 fix: the check handler gets `webContents: null` for hid/usb from sub-frames | Already correct | Our check stage refuses anything that is not ours |

## Steps (one command: `%TEMP%\opencode\upgrade-electron.ps1`)

1. `npm install electron@45.5.0 --save-exact` — pins the exact version in `package.json` and the lockfile.
2. `npm run typecheck`.
3. `npm test` — all 25 stages; the end-to-end smoke spawns the headless runtime **under the new Electron binary** (`ELECTRON_RUN_AS_NODE`), which is the first real test of better-sqlite3 and node-pty on it.
4. `npm run build`.
5. Real-window checks (each is an isolated instance: own home, profile and workspace):
   - `e2e-permissions.mjs` — the RELEASE.md list: clipboard read/write and microphone granted, camera refused in the main window, **screen capture refused**, editor and terminal present on first paint.
   - `e2e-approvals.mjs` — approval cards: deny / approve once / session grant.
   - `e2e-browser.mjs` — the hardened browser window: permissions denied from inside the page, loopback unreachable.
   - the camera window: start, live, Look (the operator's eye).
6. `npm run secrets:test:electron` — the real keychain path under the new Electron (DPAPI wrapping key lives in the profile's `Local State`; a Chromium upgrade keeps it — this proves it).
7. `npm run pack`, silent install, relaunch the installed app, repeat the clipboard/microphone/camera check on the **installed** build (RELEASE.md §"Verifying the real window").
8. Docs: `RUNTIME.md`/`SECURITY.md`/`README.md` say 42 → 45; the macOS floor; the deliberate `display-capture` refusal.

## Rollback

`git revert` the upgrade commit (package.json + lockfile) and `npm ci` — no data migration is involved: the SQLite schema is untouched, sealed secrets are keyed by the OS keychain (not by Electron's version), and the profile directory is forward-compatible for one step back.

## After it lands

- The CI workflows pick the version up from the lockfile (`npm ci`) — the macOS runner will build 45 next run; a `macos-latest` image is already ≥ 13.
- Plan the next hop on Electron's 8-week cadence: **46 is stable on 2027-01-05** (Chromium 160, Node 26 — that one *will* want a native-module check). Put a reminder on the calendar for the 45 EOL date, 2027-04-27, and treat "supported major" as a standing worklist row.
