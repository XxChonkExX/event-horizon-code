# NOTICE — Attribution

Event Horizon Code is an original breakaway project. It does not fork microsoft/vscode or anomalyco/opencode. It is MIT-licensed work that incorporates ideas and, where noted, code under the MIT License with attribution.

- Microsoft VS Code / Monaco Editor — MIT License, Copyright (c) Microsoft Corporation. https://github.com/microsoft/vscode — Monaco is used as a library component in the workbench.
- OpenCode — MIT License, Copyright (c) OpenCode contributors. https://github.com/anomalyco/opencode — Client/server session loop, tool/permission model, worktree/snapshot patterns reimplemented cleanly.
- Electron — MIT License, OpenJS Foundation. https://github.com/electron/electron
- SolidJS — MIT License, https://github.com/solidjs/solid
- AfterImage-Engram — MIT License, Copyright (c) Michael Harding / XxChonkExX. https://github.com/XxChonkExX/AfterImage-Engram — Deterministic memory, typed absence, TI-85 verification.
- VSCodium build hygiene — MIT License, https://github.com/VSCodium/vscodium — clean product.json / no-telemetry build pattern.
- Agent Skills open standard — https://agentskills.io — SKILL.md format.
- Model Context Protocol (MCP) — https://modelcontextprotocol.io
- Agent Client Protocol (ACP) — https://agentclientprotocol.com
- Language Server Protocol (LSP) / Debug Adapter Protocol (DAP) — https://microsoft.github.io/language-server-protocol/
- AgentWatch — MIT License, https://github.com/XxChonkExX/AgentWatch — deterministic local monitoring, hash-chained ledger, workspace/mail sweeper. Opt-in integration, user is final arbiter.
- chonkllama.cpp — MIT License, fork of llama.cpp (ggml-org/llama.cpp, MIT). https://github.com/XxChonkExX/chonkllama.cpp — bundled inference engine (chonk-buffer branch), pinned release binaries.
- Chat templates — `resources/templates/*.jinja`, taken verbatim from llama.cpp's `models/templates` directory (MIT License, ggml-org/llama.cpp). Each file is the canonical chat/tool template published by the corresponding model family (Qwen, DeepSeek, Gemma, GLM, Granite, Llama, Mistral, gpt-oss, Kimi, Command-R, Phi, MiniMax, Nemotron, and more). Redistributed with attribution; see docs/CHAT_TEMPLATES.md.
- Model family prompt/agent discipline — the coder persona and verify-after-edit workflow draw on published agent guidance from DeepSeek (coder FIM system framing), OpenAI Agents SDK (todo planning), and Anthropic (programmatic tool calling). Ideas only, cleanly reimplemented.
- LoopForge — MIT License, Copyright (c) Tencent. https://github.com/Tencent/LoopForge — the SOP workflow model (agent / script / human-gate nodes, rework-on-failure edges, run records with per-node artifacts, and the gated-vs-automated run-mode preference) is adapted from its design. Cleanly reimplemented in-process: LoopForge orchestrates external coding CLIs in Docker sandboxes; our SOP engine runs the local agent loop directly. See docs/SOPS.md.
- VulkanVM / Chonk Buffer — MIT License, Copyright (c) Mike/ChonkE. https://github.com/XxChonkExX/Vulkan-VM — cross-vendor GPU memory pool and transport. Runtime libraries bundled at packaging time; network transport off by default per its threat model.
- whisper.cpp — MIT License, ggml-org/whisper.cpp — planned STT sidecar bundle (Phase S2, docs/SENSORY.md), built from the same ggml substrate.
- Piper — MIT License, rhasspy/piper — planned TTS sidecar bundle (Phase S2); voices licensed per-voice, recorded in the Model Manager.
- BlackICE engram_vm — MIT License, part of AfterImage-Engram. https://github.com/XxChonkExX/AfterImage-Engram — afterimage_router.py, ti85.py, mathcheck.py, rv32.py, pyvm.py, m6502.py, thumb2.py, dataflow.py pattern incorporated cleanly. Model `Gemma-4-12b-RedTeam-BlackICE` weights: Gemma Terms of Use, https://huggingface.co/ChonkE/Gemma-4-12b-RedTeam-BlackICE — user-chosen at runtime, not shipped.
- Qwenputer compiled-computation concept — MIT License, https://github.com/divagr18/qwenputer
- WhiteRabbitNeo cyber corpus — via PJMixers/WhiteRabbitNeo on Hugging Face. Attribution retained for any engram records derived from it.
- Docker Sandbox / sbx — https://docs.docker.com/ai/sandboxes — microVM isolation, private Docker daemon, network policy, credential proxy pattern. Docs incorporated, no Docker code bundled.
- Tree-sitter — MIT License. https://tree-sitter.github.io — grammars loaded on demand, cached locally.

All trademarks remain property of their owners. "Visual Studio" is a trademark of Microsoft Corporation. "Event Horizon Code" and its logo are trademarks of XxChonkExX; the MIT license grants no rights to use them for rebranded or resold copies. This project is not affiliated with, endorsed by, or sponsored by Microsoft Corporation or the OpenCode team.

No telemetry, analytics, or cloud proxy is included. All network calls are to endpoints explicitly configured by the user (local Ollama / BYOK providers).
