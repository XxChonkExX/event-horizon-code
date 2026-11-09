# Docker compatibility and integration

## Opinion

Docker is the right isolation layer for Event Horizon Code, but not the default runtime.

- Default: run on host (Electron + local server). Fast, native UI, no VM overhead. This is the path CodeRed-418 development uses while training is running — no extra CPU/GPU load.
- Opt-in: run per-worktree agent steps in a disposable microVM/container (rcio / Docker Sandbox style). This is the path for untrusted code, `cargo install`, `npm install` of unknown deps, or parallel agents that must not share ports/DBs.

The two paths share the same server API. A worktree is tagged `sandbox: host | docker | sbx` in `.eventhorizon/worktree.json`.

## Why microVM over plain container for agents

- Container shares host kernel. A compromised agent can reach host processes.
- Docker Sandbox microVM gives separate kernel, separate Docker daemon, network proxy with deny-by-default egress, and credential proxy (tokens never enter the VM). Proven by Docker's own agent docs: Claude Code, Codex, OpenCode, Gemini CLI all run this way.
- This matches Event Horizon multi-window: 1 window = 1 worktree = 1 sandbox when sandbox mode is on.

## Implementation plan

- Toolchain Doctor checks `docker --version`, `sbx --version`, `podman --version` and reports.
- `src/server/sandbox.ts` (next step) will:
  - `sandboxMode: off | docker | sbx`
  - `sbx run --clone` for full isolation (private clone inside VM, push branches to origin, PR for review). Mirrors Docker agent workflow.
  - Direct mount for lightweight tasks (worktree bind-mounted, agent cannot touch `~/.ssh`, `$HOME`, or host Docker socket).
  - Network policy per sandbox: allow pypi/npm/crates.io by default in `balanced` profile, deny rest. User sees policy in UI.
  - Credential proxy: GitHub and model API keys stay on host, injected via `sbx secret set`.
- No Docker-in-Docker on host. Agents that need Docker get it inside the VM's private daemon.

## What not to do

- Do not run Electron itself in Docker for normal users. Electron needs a desktop session (X11 / Wayland). Docker is for the agent workload, not the UI.
- Do not bundle Docker Desktop. Detect it, link to install, keep the EHC binary small.
- Do not share the host Docker socket with an agent container. That is the escape path.

## Training sensitivity

Sandbox bring-up is CPU-heavy (image pull, VM start). It is opt-in only and disabled by default while CodeRed-418 trains. Host mode has near-zero overhead beyond the Electron windows.

## Sources

- Docker Sandbox docs: microVM with own kernel, network isolation, private Docker daemon, credential proxy.
- Agent sandboxing pattern: remio "Perfect Isolation for Multi-Agent Architectures", Aider + DevContainers.
