# Privacy

Event Horizon Code is local only. No account, no telemetry, no cloud proxy.

What stays on this machine:
- Session history, chat transcripts, file edits, terminal output, Toolchain Doctor results, engram index, audit log (under ~/.eventhorizon/).
- Secrets in OS keychain (Windows Credential Manager, macOS Keychain, libsecret), or encrypted file fallback. Never written to git or logged.

What leaves the machine:
- Only to endpoints you configured: local Ollama (127.0.0.1), llama.cpp, vLLM, or BYOK provider URLs. No other network call is made by the app.

What is not collected:
- No usage analytics, crash reporting, feature flags, or auto-update pings.
- No code, prompts, or file contents are sent anywhere except the model endpoint you chose.

Updates:
- Manual check only. No background updater phones home.

Network surface:
- Local server binds 127.0.0.1 only, random port, per-launch password, Basic auth.
- Renderer never loads remote content. Content Security Policy is set in the main process.

Detonation lane:
- Unclean interactions run in a microVM with --network off and no credentials. See docs/DETONATION.md.

Data retention:
- All history is under ~/.eventhorizon/ and can be deleted locally at any time. Git worktrees are standard git worktrees.
