// Event Horizon Code — Renderer workbench (SolidJS + Monaco)
// Multi-window aware: URL query ?session=<id> selects session/worktree.
// Layout: left file tree + sessions, center Monaco, right chat + approvals,
// bottom terminal + toolchain doctor + sandbox controls + agentwatch (opt-in). No filesystem via IPC.

import { createSignal } from "solid-js";
import ToolchainDoctor from "./ToolchainDoctor";
import SandboxControls from "./SandboxControls";
import AgentWatchPanel from "./AgentWatchPanel";

const session = new URLSearchParams(location.search).get("session") ?? "default";

export default function App() {
  const [messages, setMessages] = createSignal<string[]>([]);
  const [input, setInput] = createSignal("");
  const [activeFile, setActiveFile] = createSignal<string>("src/server/index.ts");

  const send = () => {
    const text = input().trim();
    if (!text) return;
    setMessages((m) => [...m, text]);
    setInput("");
  };

  return (
    <div class="workbench">
      <header>Event Horizon Code — session {session} — {activeFile()}</header>
      <section class="editor">
        <div class="monaco-mount" data-file={activeFile()}>
          Monaco mounts here. File: {activeFile()} (vscode Monaco, MIT).
          Language pack resolves via languages/*/language.json.
        </div>
        <div class="panels">
          <ToolchainDoctor />
          <SandboxControls />
          <AgentWatchPanel />
        </div>
      </section>
      <aside class="chat">
        <ul>{messages().map((m) => <li>{m}</li>)}</ul>
        <div class="composer">
          <input
            value={input()}
            onInput={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            placeholder="/think:high  describe the fix…"
          />
          <button onClick={send}>Send</button>
        </div>
        <p>Detonation lane available. Unclean inputs route to detonate (microVM, no net).</p>
      </aside>
      <footer class="terminal">Terminal mounts here (xterm). Per-worktree env.</footer>
    </div>
  );
}
