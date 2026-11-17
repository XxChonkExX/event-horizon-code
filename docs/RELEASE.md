# Release checklist — Event Horizon Code

The whole pipeline is hand-driven and verifiable. Nothing auto-publishes; no telemetry ever leaves the machine.

## 0. Version bump (by hand)

- Bump `version` in `package.json` directly. **Never** `npm version` (it creates tags/commits we do not want).
- Mirror the version in `src/preload/index.ts` (`version: "x.y.z"`) if it changed.
- Update `CHANGELOG.md` with a dated section.

## 1. Pre-flight (all green or no release)

```pwsh
npm run typecheck        # tsc --noEmit
npm test                 # ≈140 checks across 8 suites — must be ALL PASS
npm run test:integration # smoke: fresh headless server, 9 checks — must be ALL PASS
```

- `git status` must be clean; everything pushed to `main`.

## 2. Engine staging (the bundled llama.cpp runtime)

```pwsh
node scripts/prepare-engine.mjs            # discovers the build, copies, writes SHA256SUMS
node scripts/prepare-engine.mjs --verify   # re-verify resources/engine/ in place
```

- Source discovery order: `EH_ENGINE_SRC` → sibling `./chonkllama.cpp` checkout → the dev machine path.
- Ships only: `llama-server(.exe)`, `llama-tts(.exe)`, load-time DLLs, `mtmd` (vision). No test/bench tools.
- `resources/engine/` is gitignored — binaries never enter the repository.
- **If staging fails, the build fails.** Do not release with a stale or missing engine.

## 2b. CI workflows (what is expected to happen on GitHub)

- `ci.yml`: on every push/PR it runs the **full** `npm test` (12 stages) on
  ubuntu, after installing Electron's shared libraries. If the smoke stage
  hangs, check that `scripts/smoke-test.ts` spawns its child with
  `detached: true` on POSIX (the group-kill depends on it).
- `release.yml`: on `v*` tags (or manual dispatch) the `test` job runs the full
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
- Windows installer (optional per release): `npm run pack` → `dist/*.exe` NSIS installer.
- **Path-with-spaces note**: if the checkout lives under a path containing spaces, `@electron/rebuild` warns while rebuilding `better-sqlite3`; the build still completes (prebuilt binaries are used). Build from a space-free path if a native rebuild ever actually fails.
- Verified working 2026-11-16: engine staged (10 files, SHA-verified, chonkllama `eda0e233a`), RC launched from `win-unpacked`, spawned its own runtime, health green, sessions loaded from the shared store.
- Cosmetic warnings to expect (not failures): default Electron icon (no icon set yet), no code-signing certificate, dynamic-import notice for `renderer/api.ts`.

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
git tag -a v0.y.z -m "Event Horizon Code v0.y.z"
git push origin v0.y.z
```

- GitHub release notes template: highlights, known issues, SHA-256 table, **"requires no account, ships no model weights, no telemetry"**.
- NOTICE.md must still attribute: llama.cpp (MIT, vendored chat templates), Tencent LoopForge (MIT, SOP engine), AfterImage Engram (subprocess import).

## Known issues to state in every release (do not hide them)

- Windows compositor: under heavy GPU load a window can present a stale frame; a single click recovers it. All in-app triggers found so far are fixed; the machine-level trigger is under investigation (see `docs/GPU.md`).
- Sandbox (`sbx`/microVM) is opt-in and not shipped — the detonation lane refuses plainly without it.
- Speech-to-text (ears) is not bundled; text-to-speech works on Windows voices.
- Linux/macOS builds are on the roadmap: the runtime is portable (the engine is llama.cpp; Ollama has native Linux/macOS builds; the BYOK lane accepts any OpenAI-compatible endpoint including a self-hosted llama-server), but the packer currently stages Windows binaries only.
