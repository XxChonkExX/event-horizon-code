// Event Horizon Code — Renderer workbench (SolidJS + Monaco)
// Structure: VS Code structure (activity bar, tabs, status bar, resizable splitters).
// Look: OpenCode (deep space, glow accents, shader backdrop with easy intensity cycle).
// Pop-outs: terminal / chat in their own OS windows (?popout=<kind> route).

import { createSignal, onMount, onCleanup, Show, For, type JSX } from "solid-js";
import ToolchainDoctor from "./ToolchainDoctor";
import SandboxControls from "./SandboxControls";
import AgentWatchPanel from "./AgentWatchPanel";
import ModelManager from "./ModelManager";
import ProfilesPanel from "./ProfilesPanel";
import SessionsPanel from "./SessionsPanel";
import MemoryPanel from "./MemoryPanel";
import SensoryPanel from "./SensoryPanel";
import FileTree from "./FileTree";
import MonacoMount from "./MonacoMount";
import Terminal from "./Terminal";
import ActivityBar, { type Panel } from "./ActivityBar";
import Tabs from "./Tabs";
import StatusBar from "./StatusBar";
import ShaderBackground from "./ShaderBackground";
import Splitter from "./Splitter";
import ChatColumn, { type ChatMsg } from "./ChatColumn";
import { apiFetch, apiJson, popoutWindow, growWindow, runtimeInfo } from "./api";
import Toasts, { type Toast } from "./Toasts";

const session = new URLSearchParams(location.search).get("session") ?? "default";
const popoutKind = new URLSearchParams(location.search).get("popout");
const SHADER_STEPS = [
  { label: "off", v: 0.0 },
  { label: "subtle", v: 0.35 },
  { label: "full", v: 1.0 },
] as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const loadNum = (key: string, dflt: number, lo: number, hi: number) => {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;
};

// Adaptive defaults: on small displays the fixed columns leave the editor with
// almost nothing. Scale the defaults down instead of demanding a bigger screen.
const VW = window.innerWidth;
const VH = window.innerHeight;
const DEF_SIDEBAR = VW < 1500 ? 200 : 250;
const DEF_CHAT = VW < 1500 ? 340 : 460;
const DEF_TERM = VH < 820 ? 170 : 240;

export default function App() {
  const [messages, setMessages] = createSignal<ChatMsg[]>([]);
  // Live token stream from the server (SSE "token"); cleared when the turn ends.
  const [liveText, setLiveText] = createSignal("");
  const [liveThink, setLiveThink] = createSignal("");
  const [liveTool, setLiveTool] = createSignal("");
  // Toasts: transient status the conversation does not need to remember.
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let toastId = 0;
  const toast = (text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };
  const dismissToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const [input, setInput] = createSignal("");
  const [activeFile, setActiveFile] = createSignal<string>("src/server/index.ts");
  const [openFiles, setOpenFiles] = createSignal<string[]>(["src/server/index.ts"]);
  const [models, setModels] = createSignal<string[]>([]);
  const [model, setModel] = createSignal<string>("");
  const [think, setThink] = createSignal<string>("medium");
  const [open, setOpen] = createSignal<Record<Panel, boolean>>({ sidebar: true, chat: true, terminal: true, panels: true });
  const [shaderIdx, setShaderIdx] = createSignal(0); // default OFF - WebGL is opt-in
  // Resizable panel sizes (persisted; adaptive defaults for small displays)
  const [sidebarW, setSidebarW] = createSignal(loadNum("ehc.sidebarW", DEF_SIDEBAR, 160, 520));
  const [chatW, setChatW] = createSignal(loadNum("ehc.chatW", DEF_CHAT, 280, 800));
  const [termH, setTermH] = createSignal(loadNum("ehc.termH", DEF_TERM, 100, 600));
  // Output token budget. Reasoning models (gemma4, qwen3) spend this on their
  // thinking channel first — too small and the reply comes back empty.
  const [tokens, setTokens] = createSignal(loadNum("ehc.tokens", 1024, 64, 8192));
  // Auto-approve: let the agent run edit/write/bash without a per-call prompt.
  const [autoApprove, setAutoApprove] = createSignal(localStorage.getItem("ehc.autoApprove") === "1");
  // While a turn is in flight the composer shows a working indicator.
  const [sending, setSending] = createSignal(false);
  // Panels row: the eight tools render one at a time (tab bar), not eight
  // half-clipped columns.
  const PANELS: Array<{ id: string; label: string; el: () => JSX.Element }> = [
    { id: "sessions", label: "Sessions", el: () => <SessionsPanel /> },
    { id: "memory", label: "Memory", el: () => <MemoryPanel /> },
    { id: "models", label: "Models", el: () => <ModelManager /> },
    { id: "profiles", label: "Profiles", el: () => <ProfilesPanel /> },
    { id: "sensory", label: "Sensory", el: () => <SensoryPanel /> },
    { id: "agentwatch", label: "AgentWatch", el: () => <AgentWatchPanel /> },
    { id: "doctor", label: "Doctor", el: () => <ToolchainDoctor /> },
    { id: "sandbox", label: "Sandbox", el: () => <SandboxControls /> },
  ];
  const [panelTab, setPanelTab] = createSignal(loadNum("ehc.panelTab", 0, 0, PANELS.length - 1));

  onMount(async () => {
    try {
      const list = await apiJson<Array<{ id: string }>>("/api/models");
      setModels(list.map((m) => m.id));
      if (list.length) setModel(list[0].id);
    } catch { /* server not up yet — picker stays empty */ }
    // Replay this session's history so reopening a window continues the
    // conversation instead of showing an empty pane.
    try {
      const h = await apiJson<{ messages: Array<{ role: string; content: string }> }>(`/api/sessions/${encodeURIComponent(session)}/messages`);
      const msgs = h.messages
        .filter((m) => m.role !== "system" && m.content?.trim())
        .map((m) => ({ role: (m.role === "user" || m.role === "tool" ? m.role : "assistant") as ChatMsg["role"], text: m.content }));
      if (msgs.length) setMessages(msgs);
    } catch { /* fresh session */ }
    void openEventStream();

    // Child components (chat, panels) raise toasts through this event so they
    // do not need the toast state threaded through every prop list.
    const onToast = (ev: Event) => {
      const d = (ev as CustomEvent<{ text?: string; kind?: Toast["kind"] }>).detail;
      if (d?.text) toast(d.text, d.kind ?? "info");
    };
    window.addEventListener("ehc-toast", onToast);
    onCleanup(() => window.removeEventListener("ehc-toast", onToast));
  });

  // SSE: live tokens and tool progress for this worktree. Reconnects a few
  // times if the runtime restarts; gives up quietly after that.
  let es: EventSource | null = null;
  let esRetries = 0;
  const openEventStream = async (): Promise<void> => {
    try {
      const rt = await runtimeInfo();
      if (!rt) return;
      const q = `auth=${encodeURIComponent(rt.password)}&worktree=${encodeURIComponent(session)}`;
      es?.close();
      es = new EventSource(`${rt.baseUrl}/api/events?${q}`);
      es.addEventListener("token", (ev) => {
        try {
          const d = JSON.parse((ev as MessageEvent).data) as { sessionId?: string; delta?: string; kind?: string };
          if (d.sessionId !== session || !d.delta) return;
          if (d.kind === "reasoning") setLiveThink((t) => (t + d.delta!).slice(-2000));
          else setLiveText((t) => t + d.delta!);
        } catch { /* ignore */ }
      });
      es.addEventListener("tool-step", (ev) => {
        try {
          const d = JSON.parse((ev as MessageEvent).data) as { name?: string };
          if (d.name) setLiveTool(d.name);
        } catch { /* ignore */ }
      });
      es.onopen = () => { esRetries = 0; };
      es.onerror = () => {
        es?.close();
        if (esRetries++ < 5) setTimeout(() => void openEventStream(), 2500);
      };
    } catch { /* SSE unavailable - streaming simply stays off */ }
  };
  onCleanup(() => es?.close());

  const persistLayout = () => {
    localStorage.setItem("ehc.sidebarW", String(sidebarW()));
    localStorage.setItem("ehc.chatW", String(chatW()));
    localStorage.setItem("ehc.termH", String(termH()));
    localStorage.setItem("ehc.tokens", String(tokens()));
    localStorage.setItem("ehc.autoApprove", autoApprove() ? "1" : "0");
  };

  const toggle = (p: Panel) => setOpen((o) => ({ ...o, [p]: !o[p] }));

  // Splitter handlers. The pointer delta follows the drag, but the sign depends
  // on WHICH edge of the panel the handle sits: the handle lives in its own
  // fixed grid track, so moving it right pushes the panel to its LEFT and pulls
  // the panel to its RIGHT. Getting this wrong makes a border mirror the drag.
  //   v1 = sidebar's left edge   -> drag right narrows the sidebar
  //   v2 = sidebar's right edge  -> drag right widens the sidebar
  //   v3 = chat's left edge      -> drag right narrows the chat
  //   h1 = terminal's top edge   -> drag down grows the terminal
  const sidebarLeftEdge = (d: number) => setSidebarW(clamp(sidebarW() - d, 160, 520));
  const sidebarRightEdge = (d: number) => setSidebarW(clamp(sidebarW() + d, 160, 520));
  const chatLeftEdge = (d: number) => setChatW(clamp(chatW() - d, 280, 800));
  // h1 = terminal's top edge   -> drag UP grows the terminal, drag DOWN shrinks it.
  // The pointer delta is positive downward, and the terminal lives BELOW its handle;
  // growing it means moving that edge upward (negative delta).
  const termTopEdge = (d: number) => setTermH(clamp(termH() - d, 100, 600));
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

  // Boot-time comfort: a too-narrow window squeezes the editor against the chat
  // column. Grow once on load (grow-only, clamped in main).
  onMount(() => {
    if (window.innerWidth < 1200) void growWindow(1280);
  });
  const closeFile = (f: string) => {
    setOpenFiles((fs) => {
      const next = fs.filter((x) => x !== f);
      if (activeFile() === f && next.length) setActiveFile(next[next.length - 1]);
      return next;
    });
  };

  const send = async () => {
    const text = input().trim();
    if (!text || sending()) return;
    const thinkMatch = text.match(/\/think:(low|medium|high|max)/i);
    const lvl = thinkMatch ? thinkMatch[1].toLowerCase() : think();
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setLiveText("");
    setLiveThink("");
    setLiveTool("");
    setSending(true);
    try {
      const res = await apiFetch("/api/acp/session/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: { sessionId: session, text, think: lvl, model: model() || undefined, numPredict: tokens(), autoApprove: autoApprove(), worktree: session } })
      });
      const data = (await res.json()) as { reply?: string; thinking?: string; model?: string; tokens?: number; attempts?: number; budget?: number };
      const esc = data.attempts && data.attempts > 1 ? ` · escalated x${data.attempts} to ${data.budget} tok` : "";
      const label = data.model ? `${data.model}${data.tokens ? ` · ${data.tokens} tok` : ""}${esc}` : "echo";
      setMessages((m) => [...m, { role: "assistant", text: `— ${label} —\n${data.reply ?? ""}${data.thinking ? `\n\n[thinking]\n${data.thinking}` : ""}` }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: `— error —\nserver unreachable - is the runtime running?` }]);
    } finally {
      setSending(false);
      setLiveText("");
      setLiveThink("");
      setLiveTool("");
    }
  };

  // ---- multi-session tab bar (top strip) ----
  // Shows every session in a horizontally scrollable row - no grouping, no
  // overlay (a fixed fullscreen "manager" reliably wedged the compositor).
  type SessionTab = { id: string; title: string; messageCount: number };
  const [sessionTabs, setSessionTabs] = createSignal<SessionTab[]>([{ id: session, title: `session ${session.slice(0, 6)}`, messageCount: 0 }]);
  // "x" only hides a tab; sessions are deleted from the Sessions panel.
  const [hiddenTabs, setHiddenTabs] = createSignal<Set<string>>(new Set());
  const unhideAllTabs = (): void => { setHiddenTabs(new Set<string>()); void refreshSessionTabs(); };

  const refreshSessionTabs = async (): Promise<void> => {
    try {
      const list = await apiJson<Array<{ id: string; title: string; messageCount: number; lastActivity?: string | null }>>("/api/sessions");
      const ordered = [...list].sort((a, b) => (b.lastActivity ?? b.id).localeCompare(a.lastActivity ?? a.id));
      setSessionTabs(() => {
        const mine = ordered.find((s) => s.id === session);
        const cur = mine ?? { id: session, title: `session ${session.slice(0, 6)}`, messageCount: 0 };
        const rest = ordered.filter((s) => s.id !== session);
        return [cur, ...rest]
          .filter((s) => !hiddenTabs().has(s.id))
          .map((s) => ({ id: s.id, title: s.title, messageCount: s.messageCount ?? 0 }));
      });
    } catch { /* strip falls back to just the current tab */ }
  };

  const closeSessionTab = (id: string): void => {
    if (id === session) { toast("the current session cannot be hidden - switch to another first", "warn"); return; }
    setHiddenTabs((s) => new Set(s).add(id));
    setSessionTabs((ts) => ts.filter((t) => t.id !== id));
  };

  const openSession = (id: string): void => {
    if (id === session) return;
    // Switch this window to the chosen session (full reload - the app keys its
    // state off the ?session= query).
    window.location.assign(`/?session=${encodeURIComponent(id)}`);
  };

  const deleteSessionTab = async (id: string): Promise<void> => {
    if (id === session) { toast("cannot close the session you are in", "warn"); return; }
    if (!window.confirm(`Delete session "${id}" and its history?`)) return;
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refreshSessionTabs();
      toast(`session ${id.slice(0, 8)} deleted`, "ok");
    } catch { toast("could not delete session", "error"); }
  };

  onMount(() => { void refreshSessionTabs(); });

  const newWorktree = async () => {
    try {
      const r = await apiFetch("/api/worktrees", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = (await r.json()) as { ok: boolean; path?: string };
      toast(`worktree ${d.ok ? "created" : "failed"}: ${d.path ?? "?"}`, d.ok ? "ok" : "error");
    } catch { toast("worktree failed — server unreachable", "error"); }
  };

  // Fork this session and open the branch in a second window: two agents, two
  // approaches, one original (multi-window parallel work).
  const forkSession = async () => {
    try {
      const r = await apiFetch(`/api/sessions/${encodeURIComponent(session)}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = (await r.json()) as { sessionId?: string; error?: string };
      if (d.sessionId) {
        toast(`session forked -> ${d.sessionId.slice(0, 14)} (switched this window)`, "ok");
        openSession(d.sessionId);
      } else {
        const why = `fork failed: ${d.error ?? "?"}`;
        toast(why, "error");
        // Fixed-position toasts can be displaced by the compositor splay; the
        // transcript is in-flow layout, so echo failures there too - readable
        // whenever the conversation pane paints.
        setMessages((m) => [...m, { role: "tool", text: why }]);
      }
    } catch {
      toast("fork failed - server unreachable", "error");
      setMessages((m) => [...m, { role: "tool", text: "fork failed - server unreachable" }]);
    }
  };

  const checkpointSession = async () => {
    try {
      const r = await apiFetch(`/api/sessions/${encodeURIComponent(session)}/checkpoints`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "manual checkpoint" }) });
      const d = (await r.json()) as { seq?: number; error?: string };
      toast(d.seq !== undefined ? `checkpoint saved at message ${d.seq}` : `checkpoint failed: ${d.error ?? "?"}`, d.seq !== undefined ? "ok" : "error");
      if (d.seq === undefined) setMessages((m) => [...m, { role: "tool", text: `checkpoint failed: ${d.error ?? "?"}` }]);
    } catch { toast("checkpoint failed — server unreachable", "error"); }
  };

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
          tokens={tokens} setTokens={(n) => { setTokens(clamp(n, 64, 8192)); }}
          autoApprove={autoApprove} setAutoApprove={(v) => { setAutoApprove(v); persistLayout(); }}
          compact
        />
      </div>
    );
  }

  return (
    <div class="workbench" style={{ "grid-template-columns": cols(), "grid-template-rows": rows() }}>
      <ShaderBackground intensity={shaderIntensity} />
      <header class="ehc-chat-tabs">
        <div class="chat-tabstrip">
          <div class="chat-tabs-scroll" role="tablist" aria-label="Agent sessions">
            <For each={sessionTabs()}>
              {(t) => (
                <div
                  class="chat-tab"
                  classList={{ "chat-tab-on": t.id === session }}
                  role="tab"
                  aria-selected={t.id === session}
                  title={`${t.title} (${t.messageCount} messages) - window #${t.id.slice(0, 10)}`}
                  onClick={() => openSession(t.id)}
                >
                  <span class="chat-tab-title">{t.title || t.id}</span>
                  <span class="chat-tab-meta">{t.messageCount}</span>
                  <button class="chat-tab-close" title="Hide this tab (session preserved)" onClick={(e) => { e.stopPropagation(); closeSessionTab(t.id); }}>x</button>
                </div>
              )}
            </For>
          </div>
          <Show when={hiddenTabs().size > 0}>
            <button class="chat-tabs-unhide" title="Show tabs hidden with x" onClick={unhideAllTabs}>{hiddenTabs().size} hidden · show</button>
          </Show>
          <button
            class="chat-tab-new"
            title="Fork current session into a new window"
            aria-label="Fork current session into a new window"
            onClick={() => void forkSession()}
          >+</button>
        </div>
      </header>

      <ActivityBar open={open} toggle={toggle} />

      <Show when={open().sidebar}>
        <Splitter direction="col" class="ehc-split-v1" onDelta={sidebarLeftEdge} onEnd={persistLayout} />
        <section class="sidebar">
          <FileTree onSelect={openFile} />
        </section>
      </Show>

      <Splitter direction="col" class="ehc-split-v2" onDelta={sidebarRightEdge} onEnd={persistLayout} />

      <section class="main-area">
        <Tabs files={openFiles} active={activeFile} onSelect={setActiveFile} onClose={closeFile} />
        <MonacoMount file={activeFile()} />
        <Show when={open().panels}>
          <div class="panels">
            <div class="panel-tabs" role="tablist">
              <For each={PANELS}>{(p, i) => (
                <button
                  class="panel-tab"
                  classList={{ "panel-tab-on": panelTab() === i() }}
                  role="tab"
                  onClick={() => { setPanelTab(i()); localStorage.setItem("ehc.panelTab", String(i())); }}
                >{p.label}</button>
              )}</For>
            </div>
            <div class="panel-body">{PANELS[panelTab()].el()}</div>
          </div>
        </Show>
      </section>

      <Show when={open().chat}>
        <Splitter direction="col" class="ehc-split-v3" onDelta={chatLeftEdge} onEnd={persistLayout} />
        <ChatColumn
          messages={messages} input={input} setInput={setInput} onSend={send}
          models={models} model={model} setModel={setModel} think={think} setThink={setThink}
          tokens={tokens} setTokens={(n) => { setTokens(clamp(n, 64, 8192)); }}
          autoApprove={autoApprove} setAutoApprove={(v) => { setAutoApprove(v); persistLayout(); }}
          sending={sending} liveText={liveText} liveThink={liveThink} liveTool={liveTool}
        />
      </Show>

      <Show when={open().terminal}>
        <Splitter direction="row" class="ehc-split-h1" onDelta={termTopEdge} onEnd={persistLayout} />
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

      <StatusBar session={session} file={activeFile} model={model} think={think} shader={() => SHADER_STEPS[shaderIdx()].label} onShader={cycleShader} />
      <Toasts toasts={toasts} dismiss={dismissToast} />
    </div>
  );
}
