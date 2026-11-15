# Sensory & motor architecture — the body plan

Event Horizon as an organism. Every part is local-first, opt-in, and follows the ladder:
`bundled sidecar → user's existing stack → BYOK gateway → honest error`. Nothing auto-downloads.

| Faculty | Stack | Protocol | Status |
|---|---|---|---|
| **Brain** | chonkllama.cpp (chonk-buffer) + VulkanVM pool | OpenAI `/v1` | ✅ wired (`/api/engine/*`) |
| **Arms/legs** | Tool registry, worktrees, PTY, detonation lane | tools/call, ACP | ✅ wired |
| **Immune system** | AgentWatch (opt-in), permission gates, audit ledger | sweep/gate | ✅ wired |
| **Eyes** | llama.cpp **mtmd** (multimodal) — `mtmd.dll` already in the bundled engine build | OpenAI content parts (image_url) via llama-server | 🔧 Phase S1 (below) |
| **Ears** | whisper.cpp sidecar — same ggml core, Vulkan backend possible, CPU fine | `/inference` (whisper-server) | 📋 Phase S2 |
| **Mouth** | Piper or Kokoro (onnx, small, CPU) | local CLI/HTTP sidecar | 📋 Phase S2 |
| **Skin/proprioception** | AgentWatch runtime posture (ports, processes, drivers) | `aw posture` | ✅ Phase B wired |

## Eyes — vision (S1) — **VERIFIED LIVE 2026-11-11**

The bundled engine already contains `mtmd.dll` + `llama-mtmd-cli.exe`. Vision flow:

1. User loads a vision-capable GGUF (+ its `mmproj` file) through the Model Manager — e.g. their own Gemma models, Qwen2-VL, MiniCPM-V.
2. `llama-server` serves `/v1/chat/completions` with OpenAI content parts: `{type:"text"}`, `{type:"image_url", image_url:{url:"data:image/png;base64,..."}}`.
3. Router `chatOpenAI()` already accepts content parts (wired with the router's images support).
4. Agent tools gain: `screenshot` (capture window/screen to data URL), `paste-image` in chat composer, `read_image <path>` (server-side base64).

**Live verification (this machine):** treatment-Q8_0.gguf (Gemma-4-12b fine-tune) + `mmproj-gemma-4-12B-it-Q8_0.gguf` (159MB, ggml-org) via `--mmproj`. Server: `loaded multimodal model`. Test: 256x256 PNG, cyan "42" on black, drawn with System.Drawing, sent as data-URL content part. Model read it: *"the number '42' in a bright blue font against a black background... the answer is '42'"*, finish=stop, 10.5 t/s with vision. The mmproj pairs with **any Gemma-4-12b-derived GGUF** (Glitter Boy, Red Team line — one `--mmproj` flag each).

Use cases: read error dialogs, review UI screenshots, parse architecture diagrams, verify visual output of frontend work. The agent gets eyes on the thing it built.
## Ears - speech-to-text (S2) - **surface implemented, sidecar not installed**

`src/server/sensory.ts` implements the ears ladder. Nothing is bundled or
downloaded automatically (house rule) - the module detects what exists and
refuses plainly otherwise:

- Detection: config paths (`.harness/config.json` `sensory.stt.{bin,model}`) >
  `resources/sensory/` > `~/.eventhorizon/sensory/`. Every path tried is listed
  in the doctor.
- Endpoint: `POST /api/sensory/transcribe {audioBase64}` (16 kHz mono WAV) ->
  runs the whisper CLI (timestamps stripped) -> `{text}`. Transcripts land in
  the composer for editing before send (never auto-send).
- Absence: `{ok:false, error:"ears (STT) not ready - install whisper.cpp and a
  ggml model (GET /api/sensory/doctor says exactly what is missing)"}`.
- `GET /api/sensory/doctor` states what to install, where to drop it, and what
  was tried - no download happens on its own.

## Mouth - text-to-speech (S2) - **surface implemented, sidecar not installed**

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
