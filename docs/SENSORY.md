# Sensory & motor architecture — the body plan

Event Horizon as an organism. Every part is local-first and opt-in, and follows the ladder:
`bundled sidecar → user's existing stack → BYOK gateway → honest error`. Nothing downloads unless the user clicks it.

| Faculty | Stack | Protocol | Status |
|---|---|---|---|
| **Brain** | chonkllama.cpp (chonk-buffer) + VulkanVM pool | OpenAI `/v1` | ✅ wired (`/api/engine/*`) |
| **Arms/legs** | Tool registry, worktrees, PTY, detonation lane | tools/call, ACP | ✅ wired |
| **Immune system** | AgentWatch (opt-in), permission gates, audit ledger | sweep/gate | ✅ wired |
| **Eyes** | llama.cpp **mtmd** (multimodal) — `mtmd.dll` already in the bundled engine build | OpenAI content parts (image_url) via llama-server | 🔧 Phase S1 (below) |
| **Ears** | whisper.cpp sidecar - official CPU build + a language model, both an optional one-click download | local CLI (`whisper-cli`) | ✅ wired (`/api/sensory/transcribe`, composer mic button) |
| **Mouth** | Piper or Kokoro (onnx, small, CPU) | local CLI/HTTP sidecar | 📋 Phase S2 |
| **Skin/proprioception** | AgentWatch runtime posture (ports, processes, drivers) | `aw posture` | ✅ Phase B wired |
| **Presence / camera** | user's camera -> vision model (the engine's multimodal lane) + an on-screen agent presence | sensor bus | 📋 proposed - [SENSORS.md](SENSORS.md) |
| **Range / radio** | lidar (ROS 2 drivers), SDR direction finding, depth | sensor bus, ROS 2 bridge | 📋 proposed - [SENSORS.md](SENSORS.md) |
| **Web** | a minimal, hardened browser window | Electron `WebContentsView`, own session | 📋 proposed - [BROWSER.md](BROWSER.md) |

## Eyes — vision (S1) — **VERIFIED LIVE 2026-11-11**

The bundled engine already contains `mtmd.dll` + `llama-mtmd-cli.exe`. Vision flow:

1. User loads a vision-capable GGUF (+ its `mmproj` file) through the Model Manager — e.g. their own Gemma models, Qwen2-VL, MiniCPM-V.
2. `llama-server` serves `/v1/chat/completions` with OpenAI content parts: `{type:"text"}`, `{type:"image_url", image_url:{url:"data:image/png;base64,..."}}`.
3. Router `chatOpenAI()` already accepts content parts (wired with the router's images support).
4. Agent tools gain: `screenshot` (capture window/screen to data URL), `paste-image` in chat composer, `read_image <path>` (server-side base64).

**Live verification (this machine):** treatment-Q8_0.gguf (Gemma-4-12b fine-tune) + `mmproj-gemma-4-12B-it-Q8_0.gguf` (159MB, ggml-org) via `--mmproj`. Server: `loaded multimodal model`. Test: 256x256 PNG, cyan "42" on black, drawn with System.Drawing, sent as data-URL content part. Model read it: *"the number '42' in a bright blue font against a black background... the answer is '42'"*, finish=stop, 10.5 t/s with vision. The mmproj pairs with **any Gemma-4-12b-derived GGUF** (Glitter Boy, Red Team line — one `--mmproj` flag each).

Use cases: read error dialogs, review UI screenshots, parse architecture diagrams, verify visual output of frontend work. The agent gets eyes on the thing it built.
## Ears - speech-to-text - **VERIFIED LIVE 2026-11-25**

Press the microphone button in the composer to record; press it again to transcribe. While recording the button stays pressable and shows a level meter, a clock and a discard button, and it stops by itself at 60 s. The transcript is inserted into the composer for you to edit - it is never sent on its own. A picker beside the button chooses between several inputs and remembers the choice.

**Nothing here happens without you.** The app never downloads, installs or reports anything on its own. Three ways to get the two pieces (the `whisper-cli` engine and a `ggml-*.bin` language model):

1. **Optional download (Windows x64 / ARM64)** - Sensory panel → **download**. The engine comes from the official whisper.cpp release on GitHub, the models from the project's own Hugging Face repository. Every row is pinned - URL, size, the SHA-256 the source publishes - and a file that does not match is deleted, never installed. One at a time, progress, cancel. Files land in `~/.eventhorizon/sensory/`.
2. **Your package manager or your own build** - Homebrew (`brew install whisper-cpp`), Arch (`pacman -S whisper.cpp`), or built from source. Event Horizon finds `whisper-cli` on `PATH`. Models still come from the panel, or drop any `ggml-*.bin` into the sensory folder by hand.
3. **By config** - `.harness/config.json` → `sensory.stt.{bin,model,language}` points at exact paths.

`src/server/sensory.ts` implements the ladder:

- Detection: config paths > `resources/sensory/` > `~/.eventhorizon/sensory/` for both engine and models, plus `whisper-cli` / `whisper-server` on `PATH` (the old binary name `main` is accepted in the candidate dirs but never on `PATH` - it could be anything). Every model present is listed, best first.
- Model choice: the request's `model` (a file name from the installed list - never an arbitrary path) wins; otherwise the biggest installed model, preferring the English-only twin when the spoken language is English and the multilingual one otherwise.
- Endpoint: `POST /api/sensory/transcribe {audioBase64, language?, model?}` - a 16 kHz mono WAV, at most about 8 minutes. Runs `whisper-cli -nt -np`; the transcript is read from stdout only (the CLI's progress log goes to stderr and is not part of the text).
- Absence: `{ok:false, error:"ears (STT) not ready - …"}`, and in the app the mic button takes you to the Sensory panel instead of recording.
- `GET /api/sensory/catalog` lists the pinned downloads with what is installed; `POST /api/sensory/fetch {id}` starts one, `DELETE` cancels, `GET /api/sensory/fetch/status` reports progress.

Measured on the reference machine (CPU, alongside a training run): `ggml-base.en` transcribes 11 s of speech in 0.7 s, `ggml-small.en` in 2.1 s with better punctuation - `small.en` is the recommended default for English. Through the full UI path, 13 s of speech came back as text in 2.3 s.

Tests: `npm run sensory:test` (honest absence, input validation, and a live transcription when `EH_STT_SAMPLE=<speech.wav>` is set) and `npm run sensoryfetch:test` (allowlist, ZIP reader, download loop, verify-then-install - all offline).

## Mouth - text to speech - **adapter-based, platform-aware default**

`src/server/tts.ts` (server adapters) + `src/renderer/speech.ts` (OS voices).

| Adapter | Where | Default on | Notes |
|---|---|---|---|
| `system` | renderer, Web Speech API | **Windows** | OS voices (Microsoft set, incl. the classic SAM family). Instant, no model, no download. Voices are swappable in the composer. |
| `engine` | server, `llama-tts.exe` from chonkllama | **Linux / macOS / ARM** | Pocket TTS (tiny, ~100M, CC BY 4.0) or Qwen3-TTS (1.7B, multilingual). GGUF, GPU or CPU, zero new runtime. Voices = speaker reference recordings (voice cloning). |
| `piper` | server, rhasspy/piper | — | Optional sidecar (see the ears section for the install ladder). |
| `byok` | server, own endpoint | — | Bring your own key; no telemetry. Not configured by default. |

- `GET /api/tts/voices` -> preferred adapter, platform, defaultMode, adapters with
  plain-language notes, and every available voice (built-in, reference, system).
- `POST /api/tts/speak {text, voice?, adapter?}` -> `{ok, audio}` (wav data URL).
  The `system` adapter deliberately refuses server-side synthesis and says so: it
  plays in the renderer where the OS voices live.
- UI: a **speak** button on every assistant answer, a **voice** picker plus a
  **test** button in the composer. The pick persists in localStorage.
- Voices: drop a wav/mp3 into `~/.eventhorizon/voices/` (or set `tts.voicesDir`)
  and it appears in the picker as a reference voice for the engine adapter.
- Tests: `npm run tts:test` (18 checks) covers the platform default, honest
  absence notes, refusals, and voice listing.

## Legacy piper path (still supported)

- Piper (MIT) as an onnx sidecar. CPU is plenty; voices are 20-80MB.
- Endpoint: `POST /api/sensory/speak {text}` -> piper -> WAV returned as a data
  URL for the renderer to play.
- Detection mirrors ears (`sensory.tts.{bin,voice}` + candidate dirs).

## Status surface

- `GET /api/sensory/status` - ears/mouth presence as facts (bin, asset, ready)
  plus the tried paths.
- `GET /api/sensory/doctor` - install guidance without downloading anything.
- `/api/engine/sensory` - integrated eyes/ears/mouth flags (mtmd for vision,
  the sidecar module for ears and mouth).
- The **Sensory panel** in the workbench shows all three with ready/missing
  state and the doctor's guidance.

When you choose to install: drop `whisper-cli.exe` + a `ggml-*.bin` model and
`piper.exe` + a voice (`*.onnx` + `*.onnx.json`) into `resources/sensory/` or
`~/.eventhorizon/sensory/` - detection picks them up with no code changes.
