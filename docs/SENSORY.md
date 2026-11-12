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

## Ears — speech-to-text (S2)

whisper.cpp builds from the same ggml substrate — same repo family as chonkllama. Plan:

- Bundle `whisper-server` (CPU default; Vulkan pooled optional) + a small model (user-downloads per house rule; base/small en are ~75-466MB).
- Endpoint: `POST /api/sensory/stt` (multipart audio) → text into the composer.
- UX: hold-mic button in composer, transcript lands in the input for editing before send (never auto-send).

## Mouth — text-to-speech (S2)

- Piper (MIT) or Kokoro (Apache-2.0) as an onnx sidecar. CPU is plenty; voices are 20-80MB.
- Endpoint: `POST /api/sensory/tts {text, voice}` → wav stream.
- UX: opt-in "speak replies" toggle per session; status bar badge; never on by default.

## Factory model

Each sense is a sidecar with the same lifecycle as the LLM engine (`src/server/engine.ts`):
config block → capability detection → spawn/stop → health → audited. The Toolchain Doctor /
capability panel reports eyes/ears/mouth present-or-missing as stated facts, never silent passes.

## Phases

- **S1 (next, CPU-light):** content-parts plumbing in router + `/api/engine/sensory` capability detection (checks for `mtmd.dll`, `whisper-server`, `piper` near the engine binary) + screenshot tool stub.
- **S2:** whisper sidecar + mic button; piper sidecar + speak toggle.
- **S3:** screen-watcher agent mode (periodic screenshots as context, opt-in), video/pipeline ingest via VulkanVM storage-stream.

## Licensing (planned bundles)

- whisper.cpp — MIT (ggml-org/whisper.cpp)
- Piper — MIT (rhasspy/piper); voices — various permissive, recorded per voice in Model Manager
- Kokoro — Apache-2.0 (alternative voice engine)
- mtmd — part of llama.cpp, MIT (already covered by chonkllama row in NOTICE.md)
