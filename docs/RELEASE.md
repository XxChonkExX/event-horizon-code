# Release checklist — Event Horizon Code

The whole pipeline is hand-driven and verifiable. Nothing auto-publishes; no telemetry ever leaves the machine.

## 0. Version bump (by hand)

- Bump `version` in `package.json` directly. **Never** `npm version` (it creates tags/commits we do not want).
- Mirror it in `src/shared/version.ts` (`APP_VERSION` - the preload and the runtime report this constant) and in `package-lock.json` (the two `version` fields at the top).
- Update `CHANGELOG.md` with a dated section.

## 1. Pre-flight (all green or no release)

```pwsh
npm run typecheck        # tsc --noEmit
npm test                 # 25 stages - must be ALL PASS
npm run test:integration # end-to-end smoke against a fresh headless server — must be ALL PASS
```

- `git status` must be clean; everything pushed to `main`.

## 2. Engine staging (the bundled llama.cpp runtime)

```pwsh
node scripts/prepare-engine.mjs            # discovers the build, copies, writes SHA256SUMS
node scripts/prepare-engine.mjs --verify   # re-verify resources/engine/ in place
```

- Source discovery order: `EH_ENGINE_SRC` → sibling `./chonkllama.cpp` checkout (`build-vk/bin/Release`, then `build/bin`). The manifest records which route was used, never an absolute path.
- Ships only: `llama-server(.exe)`, `llama-tts(.exe)`, load-time DLLs, `mtmd` (vision). No test/bench tools.
- `resources/engine/` is gitignored — binaries never enter the repository.
- **If staging fails, the build fails.** Do not release with a stale or missing engine.

## 2b. CI workflows (what is expected to happen on GitHub)

- `ci.yml`: on every push/PR it runs the **full** `npm test` on
  ubuntu, after installing Electron's shared libraries. If the smoke stage
  hangs, check that `scripts/smoke-test.ts` spawns its child with
  `detached: true` on POSIX (the group-kill depends on it).
- `release.yml`: on release tags (`0.*`; legacy `v*` still matches) or manual
  dispatch the `test` job runs the full
  suite on Windows and **gates** the `build` job. The build job skips packaging
  with a clear notice when the `ENGINE_URL` repository secret is not configured
  (no red X, no empty installer) — for an alpha released from locally verified
  `npm run pack:dir` artifacts that is the expected path. When the secret IS
  set, it must point to a zip with the pinned `llama-server.exe` + DLLs +
  `mtmd.dll`; the job then stages and SHA-verifies the engine, and **fails
  loudly** if the archive is missing the executable. An installer with an empty
  engine directory must never ship. Note: a tag-triggered run uses the workflow
  file from that tag; re-run via manual dispatch on `main` to pick up workflow
  changes made after tagging.

## 3. Build the release candidate

```pwsh
npm run pack:dir     # electron-vite build + engine staging + electron-builder --dir
```

- Produces `dist/win-unpacked/` — this folder IS the release candidate.
- Run `dist/win-unpacked/Event Horizon Code.exe` and walk the RC checklist below.
- Windows installer (optional per release): `npm run pack` → `dist/*.exe` NSIS installer + MSI. Icon artwork lives at `build/icon.png` (256px) — electron-builder bakes it into the exe/installer and synthesizes the Windows .ico from it. MSI is configured (`electron-builder.yml` -> `win.target`) and is built beside the NSIS installer.
- **Path-with-spaces note**: if the checkout lives under a path containing spaces, `@electron/rebuild` warns while rebuilding `better-sqlite3`; the build still completes (prebuilt binaries are used). Build from a space-free path if a native rebuild ever actually fails.
- Verified working 2026-11-16: engine staged (10 files, SHA-verified, chonkllama `eda0e233a`), RC launched from `win-unpacked`, spawned its own runtime, health green, sessions loaded from the shared store.
- Cosmetic warnings to expect (not failures): no code-signing certificate, dynamic-import notice for `renderer/api.ts`, and on Linux electron-builder's `desktopName` notice.

## 4. Release-candidate checklist (run against win-unpacked, not dev)

- [ ] Launches; window appears with the dark workbench (no white flash)
- [ ] Runtime: boots its own server (no dev serve running) — status bar session is real
- [ ] Sessions: `+` creates a session; Sessions panel lists/rename/delete works
- [ ] Agent: a real prompt with a tool call completes (e.g. create a file) on the bundled engine
- [ ] Editor: open a file from the sidebar, edit, Save; LSP hover works (js-ts)
- [ ] Right-click: copy/paste menu in the composer; file ops in the sidebar
- [ ] Voice: speak-replies toggle reads the answer (Windows voice)
- [ ] Panels: Sessions / Memory / Models / Profiles / Sensory / AgentWatch / Doctor / Sandbox all render and state absences honestly (no fake data)
- [ ] Privacy: `~/.eventhorizon/audit.jsonl` exists locally; nothing else phones out

## 5. Artifacts

- `dist/*.exe` (installer) and/or a zip of `dist/win-unpacked/`.
- SHA-256 every artifact:

```pwsh
Get-ChildItem dist\*.exe | ForEach-Object { (Get-FileHash $_.FullName -Algorithm SHA256).Hash + "  " + $_.Name }
```

- Paste hashes into the release notes.

## 6. Tag + publish

```pwsh
git tag -a 0.0.4a -m "Event Horizon Code 0.0.4a"   # letters per re-release inside a version; package.json stays 0.0.4
git push origin 0.0.4a
```

- GitHub release notes template: highlights, known issues, SHA-256 table, **"requires no account, ships no model weights, no telemetry"**.
- NOTICE.md must still attribute: llama.cpp (MIT, vendored chat templates), Tencent LoopForge (MIT, SOP engine), AfterImage Engram (subprocess import). whisper.cpp is an optional user download and is never bundled - say so in the notes.

## Known issues to state in every release (do not hide them)

- Windows compositor: under heavy GPU load a window can present a stale frame; a single click recovers it. All in-app triggers found so far are fixed; the machine-level trigger is under investigation (see `docs/GPU.md`).
- The detonation lane needs an OS sandbox backend (WSL2 namespaces on Windows, bubblewrap on Linux, Seatbelt on macOS) and refuses plainly without one. The microVM (`sbx`) is optional and not shipped.
- Speech-to-text needs whisper.cpp and a language model. They are never bundled: the Sensory panel offers them as an optional, checksum-verified download on Windows (x64, ARM64) and on Linux x64 (since 0.0.4b); on macOS install the engine with a package manager or build it.
- macOS is packaged **unsigned** by CI (macos-latest runner, arm64 dmg/zip, engine-less — release-mac.yml, gated on the full test suite). Gatekeeper requires right-click > Open. State exactly which platforms a release's artifacts cover.
- **Linux packages from this machine (WSL, done for 0.0.4a):** clone the tag onto the Linux filesystem (`git clone <repo> ~/build/event-horizon-code`), `npm ci`, `npm run build`, then `npx electron-builder --linux AppImage deb rpm` - never `npm run pack` there, which needs a Linux engine build (`rpm` wants `apt install rpm` once). To smoke-launch under WSLg, give the app its own `HOME` and `EH_WORKSPACE`, start it with `setsid nohup` and `--no-sandbox --disable-gpu --remote-debugging-port=<port>`, and drive it with a script run *inside* WSL (the port is not reachable from Windows). Remove the throwaway home afterwards.

## Verifying the real window (added 2026-11-25)

The in-app browser is a different browser: it has its own permission prompts and says nothing about the app. To check the app itself - layout, microphone, clipboard, camera - launch it with a loopback DevTools port and drive the real renderer:

```pwsh
& "$env:LOCALAPPDATA\Programs\event-horizon-code\Event Horizon Code.exe" --remote-debugging-port=9333
Invoke-RestMethod http://127.0.0.1:9333/json          # the page target + its webSocketDebuggerUrl
```

Node 22+ has a built-in `WebSocket`, so a short script can `Runtime.evaluate` in the page and `Page.captureScreenshot` it. Checks worth running there before a release: `navigator.permissions.query` for `clipboard-read`, `clipboard-write`, `microphone` (expect `granted`) and `camera` (expect not granted); `getUserMedia({video:true})` refused; the editor (`.ehc-editor-shell`) and terminal (`.xterm`) present on the first paint; no child of `aside.chat` extending past its right edge. Close the app and relaunch it normally afterwards.
