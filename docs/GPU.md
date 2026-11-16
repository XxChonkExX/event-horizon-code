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

## Background windows and compositor notes

Researched against OpenCode Desktop (`anomalyco/opencode`) and Hermes Desktop (`NousResearch/hermes-agent`); both are Electron shells of the same shape as EHC.

- GPU compositing is disabled app-wide (`disable-gpu-compositing`) after the "splayed/stale window, recover on click" bug class persisted through shader/canvas/backdrop-filter removals. Cause never fully isolated; CPU rasterization loses nothing here.
- `backgroundThrottling: false` stays on **every** window (main and pop-outs). Hermes Desktop relies on the same and says why: transcripts stream through rAF-gated DOM writes, and Chromium pauses rAF for blurred windows. The CPU cost is accepted deliberately.
- Three process-level switches are set pre-`ready` for the same reason: `disable-renderer-backgrounding`, `disable-backgrounding-occluded-windows`, `disable-background-timer-throttling`. (Hermes Desktop ships the same three.)
- Every `BrowserWindow` sets an explicit `backgroundColor: "#0b0b10"` so a restored/blank window can never flash white (OpenCode PR #28247).
- EHC does **not** persist window bounds — no `electron-window-state`, no saved state to corrupt. This is intentionally stronger than OpenCode's fix for #48790 (which reset a persisted `isFullScreen` lock-in) and equivalent-immune for the same class.
- Remote displays (SSH X11/VNC/RDP): Hermes disables hardware acceleration only when it detects one. Not wired in EHC yet (single-machine local use); if remote use appears, mirror that gate before blaming the compositor for flicker over the wire.

## When training finishes

Revisit a CodeRed-418 preset. Until then, model choice stays `user-at-runtime`, `defaultModel: null`.
