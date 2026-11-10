// Event Horizon Code — Renderer workbench (SolidJS + Monaco)
// Structure: VS Code (activity bar, tabs, status bar, command palette).
// Look: OpenCode (deep space, glow accents, shader backdrop with easy intensity cycle).

import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import ToolchainDoctor from "./ToolchainDoctor";
import SandboxControls from "./SandboxControls";
import AgentWatchPanel from "./AgentWatchPanel";
import FileTree from "./FileTree";
import MonacoMount from "./MonacoMount";
import Terminal from "./Terminal";
import ActivityBar, { type Panel } from "./ActivityBar";
import Tabs from "./Tabs";
import StatusBar from "./StatusBar";
import CommandPalette, { type Action } from "./CommandPalette";
import ShaderBackground from "./ShaderBackground";
import { apiFetch, apiJson } from "./api";

const session = new URLSearchParams(location.search).get("session") ?? "default";
const SHADER_STEPS = [
  { label: "subtle", v: 0.35 },
  { label: "full", v: 1.0 },
  { label: "off", v: 0.0 },
] as const;

export default function App() {
  const [messages, setMessages] = createSignal<string[]>([]);
  const [input, setInput] = createSignal("");
  const [activeFile, setActiveFile] = createSignal<string>("src/server/index.ts");
  const [openFiles, setOpenFiles] = createSignal<string[]>(["src/server/index.ts"]);
  const [models, setModels] = createSignal<string[]>([]);
  const [model, setModel] = createSignal<string>("");
  const [think, setThink] = createSignal<string>("medium");
  const [panelsOpen, setPanelsOpen] = createSignal(true);
  const [open, setOpen] = createSignal<Record<Panel, boolean>>({ sidebar: true, chat: true, terminal: true, panels: true });
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [shaderIdx, setShaderIdx] = createSignal(0);

  onMount(async () => {
    try {
      const list = await apiJson<Array<{ id: string }>>("/api/models");
      setModels(list.map((m) => m.id));
      if (list.length) setModel(list[0].id);
    } catch { /* server not up yet — picker stays empty */ }
  });

  // Ctrl+K palette
  const keyHandler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((v) => !v); }
  };
  window.addEventListener("keydown", keyHandler);
  onCleanup(() => window.removeEventListener("keydown", keyHandler));

  const toggle = (p: Panel) => setOpen((o) => ({ ...o, [p]: !o[p] }));
  const cycleShader = () => setShaderIdx((i) => (i + 1) % SHADER_STEPS.length);
  const shaderIntensity = () => SHADER_STEPS[shaderIdx()].v;

  const openFile = (f: string) => {
    setActiveFile(f);
    setOpenFiles((fs) => (fs.includes(f) ? fs : [...fs, f]));
  };
  const closeFile = (f: string) => {
    setOpenFiles((fs) => {
      const next = fs.filter((x) => x !== f);
      if (activeFile() === f && next.length) setActiveFile(next[next.length - 1]);
      return next;
    });
  };

  const send = async () => {
    const text = input().trim();
    if (!text) return;
    const thinkMatch = text.match(/\/think:(low|medium|high|max)/i);
    const lvl = thinkMatch ? thinkMatch[1].toLowerCase() : think();
    setMessages((m) => [...m, text]);
    setInput("");
    try {
      const res = await apiFetch("/api/acp/session/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: { sessionId: session, text, think: lvl, model: model() || undefined, numPredict: 400, worktree: session } })
      });
      const data = (await res.json()) as { reply?: string; thinking?: string; model?: string; tokens?: number };
      const label = data.model ? `${data.model}${data.tokens ? ` · ${data.tokens} tok` : ""}` : "echo";
      setMessages((m) => [...m, `— ${label} —\n${data.reply ?? ""}${data.thinking ? `\n\n[thinking]\n${data.thinking}` : ""}`]);
    } catch { /* server not running — local echo already recorded */ }
  };

  const newWorktree = async () => {
    try {
      const r = await apiFetch("/api/worktrees", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = (await r.json()) as { ok: boolean; path?: string };
      setMessages((m) => [...m, `worktree ${d.ok ? "created" : "failed"}: ${d.path ?? "?"}`]);
    } catch { setMessages((m) => [...m, "worktree failed — server unreachable"]); }
  };

  const actions = (): Action[] => [
    { label: "Toggle terminal", hint: "Ctrl+K then Enter", run: () => toggle("terminal") },
    { label: "Toggle sidebar (worktrees)", run: () => toggle("sidebar") },
    { label: "Toggle chat", run: () => toggle("chat") },
    { label: "Toggle panels row", run: () => toggle("panels") },
    { label: "New worktree", hint: "git worktree add", run: () => void newWorktree() },
    { label: "Cycle shader background", hint: SHADER_STEPS[shaderIdx()].label, run: cycleShader },
    { label: "Focus composer", run: () => document.querySelector<HTMLInputElement>(".composer input")?.focus() },
    { label: "Open file in editor", hint: activeFile(), run: () => openFile(activeFile()) },
  ];

  return (
    <div class="workbench">
      <ShaderBackground intensity={shaderIntensity} />
      <header>Event Horizon Code — session {session} — {activeFile()}</header>

      <ActivityBar open={open} toggle={toggle} palette={() => setPaletteOpen(true)} />

      <Show when={open().sidebar}>
        <section class="sidebar">
          <FileTree onSelect={openFile} />
        </section>
      </Show>

      <section class="main-area">
        <Tabs files={openFiles} active={activeFile} onSelect={setActiveFile} onClose={closeFile} />
        <MonacoMount file={activeFile()} />
        <Show when={open().panels}>
          <div class="panels">
            <ToolchainDoctor />
            <SandboxControls />
            <AgentWatchPanel />
          </div>
        </Show>
      </section>

      <Show when={open().chat}>
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
            <span>think</span>
            <select value={think()} onChange={(e) => setThink(e.target.value)}>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
          </div>
        </aside>
      </Show>

      <Show when={open().terminal}>
        <footer class="terminal">
          <Terminal worktree={session} />
        </footer>
      </Show>

      <StatusBar session={session} model={model} think={think} shader={() => SHADER_STEPS[shaderIdx()].label} onShader={cycleShader} />
      <CommandPalette open={paletteOpen} close={() => setPaletteOpen(false)} actions={actions} />
    </div>
  );
}
