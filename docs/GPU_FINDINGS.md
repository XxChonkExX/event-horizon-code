# GPU findings — engine validation session (2026-11-11)

Bisect results from the first full GPU validation of the bundled chonkllama engine
(build 0.4.1-dev, b11029-a20ffb5d8, Windows Vulkan, chonk-buffer branch).
Machine: RX 7900 XTX (24GB) + Arc Pro B70 (32GB), both idle during tests.

## Results

| # | Config | Model | Load | Output |
|---|---|---|---|---|
| 1 | 7900 XTX, chonk pool ON, heap 0.6, device 0 | huihui-qwen3-4b Q8 (4GB) | 0.24s (page cache) | **coherent**, 101.2 t/s |
| 2 | 7900 XTX, chonk pool ON | Technomancer-27b i1-Q4_1 (16.5GB) | ~2.5 min | **coherent** ("4"), 14.3 t/s, finish=stop |
| 3 | Pooled both cards, chonk pool ON, heap 0.85, no device pin | Qwen3.5-35B-A3B Q8 (35GB) | 2.2 min, n_ctx 262144 | token soup |
| 4 | Single 7900 XTX, chonk pool ON, --n-cpu-moe 20 | Qwen3.5-35B Q8 | ~30s | token soup |
| 5 | Single 7900 XTX, **pool OFF** (raw Vulkan), --n-cpu-moe 20 | Qwen3.5-35B Q8 | ~90s | token soup |
| 6 | **Pure CPU (-ngl 0)**, no Vulkan, no pool | Qwen3.5-35B Q8 | 2.1 min | **token soup**, 7.2 t/s |

## Verdicts

1. **The Qwen3.5-35B-A3B-Q8_0.gguf file on G: is corrupt/broken.** Soup on every
   backend including pure CPU. Bad weights produce soup everywhere; this is a file
   problem (bad download or bad conversion), not an inference-stack problem.
   Corollary: the Linux serve-parity benchmark of this model family implies a good
   copy exists elsewhere — the G: copy differs. Re-download / verify SHA / re-convert.
2. **The Chonk Buffer is fully exonerated for correctness** — pool ON/OFF made no
   difference to output sanity, and the two healthy models ran fine through it
   (config #1) and without it (config #2).
3. **Separate bug — planner flag:** `--vvm-split 'ffn_.*_exps.=auto'` crashes at
   load with `GGML_ASSERT(buft) failed` (ggml-backend.cpp:35) for this model on
   Windows, pooled, before any generation. Plain pooled load (no planner flag)
   succeeds. Repro: engine start with extraArgs exactly as above.
4. **Windows cross-vendor pooling LOADS** 35GB across 7900 XTX + B70 in one pool
   (config #3) — the placement/aliasing worked to load; correctness untestable with
   a corrupt file. Re-test after file replacement.

## Harness findings (EHC side, fixed same session)

- Shared engine.log across server processes made "which process answered?"
  ambiguous when a stale engine survived a stop. Fixed: per-pid logs
  (`engine-<pid>.log`) + port-conflict guard before spawn.
- execFile("curl") on Windows fails PATH resolution without .exe. Fixed: Node fetch.
- better-sqlite3 v12 is ABI-specific; headless vs GUI dual-runtime resolved by
  ELECTRON_RUN_AS_NODE runner, then dissolved entirely by v13 (N-API).

## Remediation queue

1. Re-download or re-convert Qwen3.5-35B-A3B Q8_0; verify SHA256 against source.
2. Re-run config #3 (pooled) — expect coherent output; then chase the 21.5 t/s
   pooled benchmark from VulkanVM docs with matching model/quant.
3. File the --vvm-split GGML_ASSERT crash with the planner regex + model to chonkllama.
4. Vision smoke needs a VLM GGUF + mmproj (user-approved download).
