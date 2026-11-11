# Engine — bundled chonkllama.cpp (one-stop inference)

Event Horizon Code can ship with its own inference engine: the **chonk-buffer branch of chonkllama.cpp** (llama.cpp fork) running on the **VulkanVM Chonk Buffer** — XxChonkExX's cross-vendor GPU memory pool (MIT ×2).

## Why this matters

- One installer = harness + engine. No separate Ollama install required.
- The Chonk Buffer pools VRAM **across vendors** — verified at 21.5 t/s on Qwen 40B pooled across RX 7900 XTX + Arc Pro B70 (56GB combined). Neither card alone can hold that model.
- Auto-placement planner (`--vvm-split ...=auto`) puts each tensor class where it runs fastest — no hand-tuned `--n-cpu-moe` sweeps.
- Storage-stream (IoRing, verified 3.29 GB/s on real NVMe) enables MoE expert offload from SSD inside the harness (Phase 3, opt-in).

## Ladder

`bundled llama-server` → user's Ollama → BYOK gateway (`secrets.json`) → honest error.

The router's `chatOpenAI()` speaks OpenAI `/v1/chat/completions` natively — llama-server plugs in directly.

## API (server)

- `GET /api/engine/status` — config + running + healthy + endpoint
- `GET /api/engine/models` — scan `engine.ggufDirs` for local GGUFs (filesystem-only)
- `POST /api/engine/start {ggufPath}` — spawn sidecar on 127.0.0.1:8901
- `POST /api/engine/stop` — kill sidecar

Env applied at spawn: `GGML_VK_VVM_POOL`, `GGML_VVM_HEAP_FRACTION`, `VVM_DEVICE_INDEX` — the GPU policy from `docs/GPU.md` becomes engine flags.

## Config (`.harness/config.json`)

```json
"engine": {
  "kind": "bundled | external | none",
  "binaryPath": "resources/engine/llama-server.exe",
  "port": 8901,
  "ggufDirs": ["F:/llmtrainingpipeline", "G:/New folder"],
  "gpu": { "deviceIndex": 0, "heapFraction": 0.6, "pool": true }
}
```

## Packaging rules

- No model ships or downloads without the user asking (house rule). Model Manager scans local dirs + offers in-app download with SHA256 later.
- EHC CI never compiles llama.cpp — installers pin release binaries from chonkllama.cpp releases by SHA, placed in `resources/engine/`.
- Bundled size: ~100–200MB compressed. Accepted: it replaces a separate 600MB+ Ollama install.
- Vulkan loader ships with GPU drivers; if absent, engine refuses with a stated error and the ladder falls to Ollama/BYOK.
- Network transport (RDMA/UCX) stays **off by default** — VulkanVM threat model says trusted networks only.

## Licensing

- llama.cpp — MIT. chonkllama.cpp — MIT (fork). VulkanVM — MIT.
- NOTICE.md rows added at packaging time.

## Phases

1. **Sidecar** (this): engine manager + API + config. Smoke against local `build-vk/bin/llama-server.exe` when GPU frees.
2. **Pooling surface**: device pinning per window, heap-fraction slider, `--vvm-split auto`, pooled-both mode; status bar shows serving card(s) + t/s.
3. **Opt-in extras**: storage-stream MoE offload; cluster mode (trusted networks only).
