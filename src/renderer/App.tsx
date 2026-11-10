// Event Horizon Code — Renderer workbench (SolidJS + Monaco)
// Multi-window aware: URL query ?session=<id> selects session/worktree.
// Layout: left file tree + sessions, center Monaco, right chat + approvals,
// bottom terminal + toolchain doctor + sandbox controls + agentwatch (opt-in). No filesystem via IPC.

import { createSignal, onMount } from "solid-js";
import { apiFetch, apiJson } from "./api";
import ToolchainDoctor from "./ToolchainDoctor";
import SandboxControls from "./SandboxControls";
import AgentWatchPanel from "./AgentWatchPanel";
import FileTree from "./FileTree";
import MonacoMount from "./MonacoMount";
import Terminal from "./Terminal";

const session = new URLSearchParams(location.search).get("session") ?? "default";

export default function App() {
  const [messages, setMessages] = createSignal<string[]>([]);
  const [input, setInput] = createSignal("");
  const [activeFile, setActiveFile] = createSignal<string>("src/server/index.ts");
  const [models, setModels] = createSignal<string[]>([]);
  const [model, setModel] = createSignal<string>("");

  onMount(async () => {
    try {
      const list = await apiJson<Array<{ id: string }>>("/api/models");
      setModels(list.map((m) => m.id));
      if (list.length) setModel(list[0].id);
    } catch { /* server not up yet — picker stays empty */ }
  });

  const send = async () => {
    const text = input().trim();
    if (!text) return;
    setMessages((m) => [...m, text]);
    setInput("");
    // Parse /think:low|medium|high|max directive for reasoning effort
    const thinkMatch = text.match(/\/think:(low|medium|high|max)/i);
    const think = thinkMatch ? thinkMatch[1].toLowerCase() : "default";
    try {
      const res = await apiFetch("/api/acp/session/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: { sessionId: session, text, think, model: model() || undefined, numPredict: 400, worktree: session } })
      });
      const data = (await res.json()) as { reply?: string; thinking?: string; model?: string; tokens?: number };
      const label = data.model ? `${data.model}${data.tokens ? ` · ${data.tokens} tok` : ""}` : "echo";
      setMessages((m) => [...m, `— ${label} —\n${data.reply ?? ""}${data.thinking ? `\n\n[thinking]\n${data.thinking}` : ""}`]);
    } catch { /* server not running — local echo already recorded */ }
  };

  return (
    <div class="workbench">
      <header>Event Horizon Code — session {session} — {activeFile()}</header>
      <section class="editor">
        <FileTree onSelect={(f) => setActiveFile(f)} />
        <MonacoMount file={activeFile()} />
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
        <div class="model-row">
          <span>model</span>
          <select value={model()} onChange={(e) => setModel(e.target.value)}>
            <option value="">(none — echo)</option>
            {models().map((m) => <option value={m}>{m}</option>)}
          </select>
        </div>
        <p>Detonation lane available. Unclean inputs route to detonate (microVM, no net).</p>
      </aside>
      <footer class="terminal">
        <Terminal worktree={session} />
      </footer>
    </div>
  );
}
