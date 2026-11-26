# Privacy

Event Horizon Code is local only. **Zero telemetry, zero cloud.** No account, no sign-in, no analytics, no crash reporting, no update check, no server of ours. Nothing is collected, and nothing leaves the machine unless you make it leave.

## What stays on this machine

- Session history, chat transcripts, file edits, terminal output, Toolchain Doctor results, speech preferences, engram index, audit log and the optional download folder - all under `~/.eventhorizon/`.
- **Microphone audio.** The microphone is opened only while you are recording, which starts only from a click on the composer's microphone button and ends on the second press, the discard button, the 60-second cap, or when the composer goes away (every path releases it - measured: the audio track reports `ended`). The recording is converted to text **on this machine**: in the app process to a WAV, handed to the local server over loopback, transcribed by whisper.cpp, and the temporary WAV is deleted. It is never stored and never uploaded. The camera is never granted to any page in the app.
- BYOK keys: sealed through the OS keychain (Electron `safeStorage` - DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux) when saved from the desktop app. Where no keychain is reachable (the headless runtime, Linux without a keyring) they are stored in plaintext and the panel labels them `PLAINTEXT`. Never written to git or logged. Verified on Windows and on Linux (GNOME/Wayland); macOS is pending - see `docs/ENCRYPTION.md`.

## What can leave the machine - and only because you asked

| What | Trigger | Destination | What is sent |
|---|---|---|---|
| Model prompts | You send a message with a BYOK model selected | The endpoint you configured | The conversation, with your key. A local engine or Ollama never leaves loopback. |
| Optional download | You click **download** in the Sensory panel | `github.com` or `huggingface.co` (and their download CDN on redirect) | A plain HTTPS GET with the generic User-Agent `event-horizon-code`. No identifier, no version report, no machine details. |
| Install link | You click **install** in the Toolchain Doctor, or a project link in the Sensory panel | The official project site, in your own browser | Whatever that browser normally sends to any site. |
| `websearch` tool | The agent calls it, and you approve (permission `ask`) | `html.duckduckgo.com` | The search query. |

Until one of those clicks or approvals happens, the app makes **no connection to anything that is not this computer**. There is no "phone home on launch", no version check, no feature-flag fetch. Downloads are optional and never required: the app is fully usable offline, and a sidecar installed by hand is detected the same way.

## What is not collected

- No usage analytics, crash reporting, feature flags, or auto-update pings. Not now, not "anonymously".
- No code, prompts, microphone audio, or file contents are sent anywhere except the model endpoint you chose.

## Optional downloads, precisely

- The only things the app can download are the rows of a fixed catalog (`src/server/sensory-catalog.ts`, generated from the sources' own published metadata): the whisper.cpp engine for Windows and eight speech models. There is no way to make it download anything else - the address is checked against an allowlist before the request and on every redirect.
- Every file is checked against the SHA-256 its source publishes. A mismatch deletes the file and installs nothing.
- One at a time, with progress, cancellable, and a stall timeout.
- Each install is recorded in the local audit log (`sensory.fetch`). That log never leaves the machine.

## Updates

Manual check only. There is no updater.

## Network surface

- Local server binds `127.0.0.1` only, random port, per-launch password, Basic auth. The renderer never holds that password; calls go through a main-process proxy.
- Renderer loads no remote content. Content Security Policy (`default-src 'self'`, connections limited to loopback) is declared in `index.html`.
- The only public hosts the app may open or download from are listed in `src/shared/externals.ts`, and that list is the single source for the Doctor's install links and the Sensory downloads.

## Detonation lane

Unclean interactions run in an OS-level sandbox with no network and no credentials: WSL2 namespaces on Windows, bubblewrap on Linux, Seatbelt on macOS (best effort). An optional microVM (`sbx`) exists and is not shipped. Without a backend the tool refuses plainly. See `docs/DETONATION.md`.

## Data retention

All history is under `~/.eventhorizon/` and can be deleted locally at any time. Optional downloads live in `~/.eventhorizon/sensory/` and are plain files - delete them to remove them. Git worktrees are standard git worktrees.
