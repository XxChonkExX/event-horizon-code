# GPU and headroom

Author machine (Windows):

- Training: Intel Arc Pro B70 32GB — CodeRed-418 training in background.
- Primary/render: AMD Radeon RX 7900 XTX — Electron/Chromium, desktop, editor.

## Policy

- Reserve B70 for training. Event Horizon Code will not allocate training VRAM.
- Electron rendering pins to 7900 XTX by default. Do not force B70 for UI.
- Dev and CI stay light while training runs: small Qwen (1.5B) smoke tests on primary only, LSP lazy-spawn capped at 6 per worktree, no background scraping, no quant, no image pulls.
- Keep at least 8GB VRAM free on B70 at all times during training.

## Process hygiene

- Agent is permitted to run programs and execute within reason.
- On session/window close: kill that session's LSP, DAP, and child processes. No orphaned `node`, `python`, `lldb`, `cargo`, `go` processes.
- Sandbox (Docker / microVM) is opt-in. Bring-up is heavy. Ask before starting a VM or image build while training is active.
- Stop at the GPU/CPU heavy spot: GGUF quant, large Docker builds, model downloads over 2GB, parallel worktree Docker builds. Surface headroom numbers first (Task Manager / `nvidia-smi`-equivalent `xpu-smi` / `rocm-smi`).
- Log any killed process in `~/.eventhorizon/audit.jsonl`.

## When training finishes

Revisit a CodeRed-418 preset. Until then, model choice stays `user-at-runtime`, `defaultModel: null`.
