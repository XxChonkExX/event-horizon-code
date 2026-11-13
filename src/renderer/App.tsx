// Event Horizon Code — Renderer workbench (SolidJS + Monaco)
// Structure: VS Code (activity bar, tabs, status bar, command palette, resizable splitters).
// Look: OpenCode (deep space, glow accents, shader backdrop with easy intensity cycle).
// Pop-outs: terminal / chat in their own OS windows (?popout=<kind> route).

import { createSignal, onMount, onCleanup, Show } from "solid-js";
import ToolchainDoctor from "./ToolchainDoctor";
import SandboxControls from "./SandboxControls";
import AgentWatchPanel from "./AgentWatchPanel";
import ModelManager from "./ModelManager";
import FileTree from "./FileTree";
import MonacoMount from "./MonacoMount";
import Terminal from "./Terminal";
import ActivityBar, { type Panel } from "./ActivityBar";
import Tabs from "./Tabs";
import StatusBar from "./StatusBar";
import CommandPalette, { type Action } from "./CommandPalette";
import ShaderBackground from "./ShaderBackground";
import Splitter from "./Splitter";
import ChatColumn from "./ChatColumn";
import { apiFetch, apiJson, popoutWindow, growWindow } from "./api";

const session = new URLSearchParams(location.search).get("session") ?? "default";
const popoutKind = new URLSearchParams(location.search).get("popout");
const SHADER_STEPS = [
  { label: "subtle", v: 0.35 },
  { label: "full", v: 1.0 },
  { label: "off", v: 0.0 },
] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const loadNum = (key: string, dflt: number, lo: number, hi: number) => {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;
};

export default function App() {
  const [messages, setMessages] = createSignal<string[]>([]);
  const [input, setInput] = createSignal("");
  const [activeFile, setActiveFile] = createSignal<string>("src/server/index.ts");
  const [openFiles, setOpenFiles] = createSignal<string[]>(["src/server/index.ts"]);
  const [models, setModels] = createSignal<string[]>([]);
  const [model, setModel] = createSignal<string>("");
  const [think, setThink] = createSignal<string>("medium");
  const [open, setOpen] = createSignal<Record<Panel, boolean>>({ sidebar: true, chat: true, terminal: true, panels: true });
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [shaderIdx, setShaderIdx] = createSignal(0);
  // Resizable panel sizes (persisted)
  const [sidebarW, setSidebarW] = createSignal(loadNum("ehc.sidebarW", 250, 160, 520));
  const [chatW, setChatW] = createSignal(loadNum("ehc.chatW", 460, 280, 800));
  const [termH, setTermH] = createSignal(loadNum("ehc.termH", 240, 100, 600));

  onMount(async () => {
    try {
      const list = await apiJson<Array<{ id: string }>>("/api/models");
      setModels(list.map((m) => m.id));
      if (list.length) setModel(list[0].id);
    } catch { /* server not up yet — picker stays empty */ }
  });

  const persistLayout = () => {
    localStorage.setItem("ehc.sidebarW", String(sidebarW()));
    localStorage.setItem("ehc.chatW", String(chatW()));
    localStorage.setItem("ehc.termH", String(termH()));
  };

  const toggle = (p: Panel) => setOpen((o) => ({ ...o, [p]: !o[p] }));
  const cycleShader = () => setShaderIdx((i) => (i + 1) % SHADER_STEPS.length);
  const shaderIntensity = () => SHADER_STEPS[shaderIdx()].v;

  const cols = () => {
    const s = open().sidebar;
    const c = open().chat;
    return [
      "46px",
      s ? "6px" : "0px", s ? `${sidebarW()}px` : "0px", s ? "6px" : "0px",
      "minmax(0, 1fr)",
      c ? "6px" : "0px", c ? `${chatW()}px` : "0px",
    ].join(" ");
  };
  const rows = () => [
    "auto",
    "minmax(0, 1fr)",
    open().terminal ? "6px" : "0px", open().terminal ? `${termH()}px` : "0px",
    "auto",
  ].join(" ");

  const openFile = (f: string) => {
    setActiveFile(f);
    setOpenFiles((fs) => {
      const next = fs.includes(f) ? fs : [...fs, f];
      // Widen the OS window when tabs need room (grow-only, clamped in main).
      const target = Math.min(980 + next.length * 80, 1800);
      if (window.innerWidth < target) void growWindow(target);
      // Keep the newly opened tab in view.
      setTimeout(() => document.querySelector(".ehc-tabs")?.scrollTo({ left: 99999, behavior: "smooth" }), 60);
      return next;
    });
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
    { label: "Toggle sidebar (worktrees)", run: () => toggle("sidebar") },
    { label: "Toggle chat", run: () => toggle("chat") },
    { label: "Toggle terminal", run: () => toggle("terminal") },
    { label: "Toggle panels row", run: () => toggle("panels") },
    { label: "Pop out chat to window", hint: "new window", run: () => void popoutWindow("chat", session) },
    { label: "Pop out terminal to window", hint: "new window", run: () => void popoutWindow("terminal", session) },
    { label: "New worktree", hint: "git worktree add", run: () => void newWorktree() },
    { label: "Cycle shader background", hint: SHADER_STEPS[shaderIdx()].label, run: cycleShader },
    { label: "Focus composer", run: () => document.querySelector<HTMLInputElement>(".composer input")?.focus() },
  ];

  // Ctrl+K palette
  const keyHandler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((v) => !v); }
  };
  window.addEventListener("keydown", keyHandler);
  onCleanup(() => window.removeEventListener("keydown", keyHandler));

  // ---- Pop-out routes: render only the popped-out panel ----
  if (popoutKind === "terminal") {
    return (
      <div class="popout-root">
        <Terminal worktree={session} />
      </div>
    );
  }
  if (popoutKind === "chat") {
    return (
      <div class="popout-root">
        <ChatColumn
          messages={messages} input={input} setInput={setInput} onSend={send}
          models={models} model={model} setModel={setModel} think={think} setThink={setThink}
          compact
        />
      </div>
    );
  }

  return (
    <div class="workbench" style={{ "grid-template-columns": cols(), "grid-template-rows": rows() }}>
      <ShaderBackground intensity={shaderIntensity} />
      <header>Event Horizon Code — session {session} — {activeFile()}</header>

      <ActivityBar open={open} toggle={toggle} palette={() => setPaletteOpen(true)} />

      <Show when={open().sidebar}>
        <Splitter direction="col" class="ehc-split-v1" onDelta={(d) => setSidebarW(clamp(sidebarW() + d, 160, 520))} onEnd={persistLayout} />
        <section class="sidebar">
          <FileTree onSelect={openFile} />
        </section>
      </Show>

      <Splitter direction="col" class="ehc-split-v2" onDelta={(d) => setSidebarW(clamp(sidebarW() - d, 160, 520))} onEnd={persistLayout} />

      <section class="main-area">
        <Tabs files={openFiles} active={activeFile} onSelect={setActiveFile} onClose={closeFile} />
        <MonacoMount file={activeFile()} />
        <Show when={open().panels}>
          <div class="panels">
            <ToolchainDoctor />
            <SandboxControls />
            <AgentWatchPanel />
            <ModelManager />
          </div>
        </Show>
      </section>

      <Show when={open().chat}>
        <Splitter direction="col" class="ehc-split-v3" onDelta={(d) => setChatW(clamp(chatW() - d, 280, 800))} onEnd={persistLayout} />
        <ChatColumn
          messages={messages} input={input} setInput={setInput} onSend={send}
          models={models} model={model} setModel={setModel} think={think} setThink={setThink}
        />
      </Show>

      <Show when={open().terminal}>
        <Splitter direction="row" class="ehc-split-h1" onDelta={(d) => setTermH(clamp(termH() - d, 100, 600))} onEnd={persistLayout} />
        <footer class="terminal">
          <div class="term-wrap">
            <div class="ehc-toolbar">
              <span>Terminal</span>
              <button title="Pop out to window" onClick={() => void popoutWindow("terminal", session)}>⧉</button>
            </div>
            <Terminal worktree={session} />
          </div>
        </footer>
      </Show>

      <StatusBar session={session} model={model} think={think} shader={() => SHADER_STEPS[shaderIdx()].label} onShader={cycleShader} />
      <CommandPalette open={paletteOpen} close={() => setPaletteOpen(false)} actions={actions} />
    </div>
  );
}
