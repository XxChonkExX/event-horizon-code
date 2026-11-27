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
import RunsPanel from "./RunsPanel";
import MemoryPanel from "./MemoryPanel";
import SensoryPanel from "./SensoryPanel";
import FileTree from "./FileTree";
import MonacoMount from "./MonacoMount";
import CameraWindow from "./CameraWindow";
import Terminal from "./Terminal";
import ActivityBar, { type Panel } from "./ActivityBar";
import Tabs from "./Tabs";
import StatusBar from "./StatusBar";
import ShaderBackground from "./ShaderBackground";
import Splitter from "./Splitter";
import ChatColumn, { type ChatMsg } from "./ChatColumn";
import { apiFetch, apiJson, popoutWindow, growWindow, runtimeInfo, eventStreamTicket } from "./api";
import { activeGrants, noteApproval, pendingApprovals, resolveApproval, refreshApprovals, type ApprovalRequest } from "./approvals";
import ApprovalsMenu from "./ApprovalsMenu";
import Toasts, { type Toast } from "./Toasts";
import ContextMenu, { openContextMenu } from "./ContextMenu";

const bootSession = new URLSearchParams(location.search).get("session") ?? "default";
// Mutable: in-place session switching (no window reload) updates this; every
// closure reads the CURRENT value at call time. sessionSig mirrors it for
// reactive renders (tab highlight, status bar).
let session = bootSession;
const popoutKind = new URLSearchParams(location.search).get("popout");
// The directory this session's tools/terminal/LSP operate in - from the session
// row (its `worktree` column), never the session id itself.
const bootWorktree = new URLSearchParams(location.search).get("wt") ?? ".";
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
  // Live session id for reactive renders (strip highlight, status bar) and a
  // version counter that forces session-bound components (Terminal PTY,
  // Monaco worktree content) to remount on an in-place switch.
  const [sessionSig, setSessionSig] = createSignal(session);
  // Starts at 1, not 0: the keyed wrappers below mount the editor and the
  // terminal only while this is truthy. At 0 neither existed on the boot
  // session - files opened as tabs with no editor behind them - until the
  // first session switch bumped it.
  const [sessionVersion, setSessionVersion] = createSignal(1);
  // Operator command surface: global pause + capabilities.
  const [agentsPaused, setAgentsPaused] = createSignal(false);
  const fetchRuntimePause = async (): Promise<void> => {
    try {
      const r = await apiFetch("/api/runtime/pause");
      const d = (await r.json()) as { paused?: boolean };
      setAgentsPaused(d.paused === true);
    } catch { /* preview shell without the app */ }
  };
  const toggleAgentsPaused = async (): Promise<void> => {
    const next = !agentsPaused();
    try {
      const r = await apiFetch("/api/runtime/pause", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: next }) });
      const d = (await r.json()) as { paused?: boolean };
      setAgentsPaused(d.paused === next);
    } catch { toast(next ? "could not pause agents" : "could not resume agents", "error"); }
  };
  // Directory tools/terminal/LSP operate in: from the session row's worktree
  // column (popouts receive it in the ?wt= query).
  const [wt, setWt] = createSignal<string>(bootWorktree);
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
  // In-flight turns are per session: one session waiting (possibly on an
  // approval for minutes) must neither block another nor paste its reply into it.
  const [sendingIds, setSendingIds] = createSignal<ReadonlySet<string>>(new Set());
  const setSendingFor = (sid: string, on: boolean): void => { setSendingIds((s) => { const n = new Set(s); if (on) n.add(sid); else n.delete(sid); return n; }); };
  const sending = (): boolean => sendingIds().has(sessionSig());
  const [approvalsMenu, setApprovalsMenu] = createSignal(false);
  // Panels row: the eight tools render one at a time (tab bar), not eight
  // half-clipped columns.
  const PANELS: Array<{ id: string; label: string; el: () => JSX.Element }> = [
    { id: "sessions", label: "Sessions", el: () => <SessionsPanel onChanged={() => { void refreshSessionTabs(); }} current={sessionSig} /> },
    { id: "runs", label: "Runs", el: () => <RunsPanel /> },
    { id: "memory", label: "Memory", el: () => <MemoryPanel /> },
    { id: "models", label: "Models", el: () => <ModelManager /> },
    { id: "profiles", label: "Profiles", el: () => <ProfilesPanel /> },
    { id: "sensory", label: "Sensory", el: () => <SensoryPanel /> },
    { id: "agentwatch", label: "AgentWatch", el: () => <AgentWatchPanel /> },
    { id: "doctor", label: "Doctor", el: () => <ToolchainDoctor /> },
    { id: "sandbox", label: "Sandbox", el: () => <SandboxControls /> },
  ];
  const [panelTab, setPanelTab] = createSignal(loadNum("ehc.panelTab", 0, 0, PANELS.length - 1));
  // Side-bar "Session log manager" button: reveals the bottom panels row with
  // the Sessions tab selected (toggle again to hide it).
  const SESSIONS_TAB = 0;
  const sessionsActive = (): boolean => open().panels && panelTab() === SESSIONS_TAB;
  const toggleSessionLog = (): void => {
    if (sessionsActive()) { setOpen((o) => ({ ...o, panels: false })); return; }
    setOpen((o) => ({ ...o, panels: true }));
    setPanelTab(SESSIONS_TAB);
    try { localStorage.setItem("ehc.panelTab", String(SESSIONS_TAB)); } catch { /* private mode */ }
  };

  onMount(async () => {
    try {
      const list = await apiJson<Array<{ id: string }>>("/api/models");
      setModels(list.map((m) => m.id));
      if (list.length) setModel(list[0].id);
    } catch { /* server not up yet - picker stays empty */ }
    // Replay this session's history so reopening a window continues the
    // conversation instead of showing an empty pane.
    await loadSessionState(session);
    void openEventStream();

    // Child components (chat, panels) raise toasts through this event so they
    // do not need the toast state threaded through every prop list.
    const onToast = (ev: Event) => {
      const d = (ev as CustomEvent<{ text?: string; kind?: Toast["kind"] }>).detail;
      if (d?.text) toast(d.text, d.kind ?? "info");
    };
    window.addEventListener("ehc-toast", onToast);
    // "Open in terminal" (file tree / editor tabs) asks for the panel to be
    // shown; the PTY itself consumes the cd request on mount or live.
    const onWantTerminal = () => setOpen((o) => ({ ...o, terminal: true }));
    window.addEventListener("ehc:want-terminal", onWantTerminal);
    // A child asks for a panel by id (the composer's speech-setup path opens
    // the Sensory panel). The tab strip scrolls so the tab is actually seen.
    const onWantPanel = (ev: Event) => {
      const i = PANELS.findIndex((p) => p.id === (ev as CustomEvent<{ id?: string }>).detail?.id);
      if (i < 0) return;
      setOpen((o) => ({ ...o, panels: true }));
      setPanelTab(i);
      try { localStorage.setItem("ehc.panelTab", String(i)); } catch { /* private mode */ }
      revealPanelTab();
    };
    window.addEventListener("ehc:want-panel", onWantPanel);
    revealPanelTab();
    onCleanup(() => {
      window.removeEventListener("ehc-toast", onToast);
      window.removeEventListener("ehc:want-terminal", onWantTerminal);
      window.removeEventListener("ehc:want-panel", onWantPanel);
    });
  });
  const revealPanelTab = (): void => {
    requestAnimationFrame(() => panelTabsRef?.querySelector(".panel-tab-on")?.scrollIntoView({ inline: "nearest", block: "nearest" }));
  };
  let panelTabsRef: HTMLDivElement | undefined;

  // (Re)load everything that is per-session: history, live streams. Called on
  // boot and on every in-place switch.
  const loadSessionState = async (id: string): Promise<void> => {
    setMessages([]);
    setLiveText("");
    setLiveThink("");
    setLiveTool("");
    try {
      const h = await apiJson<{ messages: Array<{ role: string; content: string }> }>(`/api/sessions/${encodeURIComponent(id)}/messages`);
      const msgs = h.messages
        .filter((m) => m.role !== "system" && m.content?.trim())
        .map((m) => ({ role: (m.role === "user" || m.role === "tool" ? m.role : "assistant") as ChatMsg["role"], text: m.content }));
      if (msgs.length) setMessages(msgs);
    } catch { /* fresh session */ }
    es?.close();
    void openEventStream();
  };

  // In-place switch: no window reload. Session-bound components (Terminal PTY,
  // Monaco worktree content) remount via the sessionVersion keyed wrapper.
  const switchSession = (id: string): void => {
    if (id === session) return;
    session = id;
    setSessionSig(id);
    // Swap ONLY the query: on file: protocol a path-relative replaceState
    // ("/?session=...") rewrites the URL down to the drive root, which broke
    // every subsequent IPC trust check (sweep: "C:\ vs full path" mismatch).
    const u = new URL(location.href);
    u.search = `?session=${encodeURIComponent(id)}`;
    history.replaceState(null, "", u);
    void refreshSessionTabs();
    void loadSessionState(id);
    setSessionVersion((v) => v + 1);
  };

  // SSE: live tokens and tool progress for this worktree. Reconnects a few
  // times if the runtime restarts; gives up quietly after that.
  let es: EventSource | null = null;
  let esRetries = 0;
  const openEventStream = async (): Promise<void> => {
    try {
      const rt = await runtimeInfo();
      if (!rt) return;
      // EH-010 + sweep-5: the ticket is minted in MAIN (the credential never
      // enters the renderer); the URL carries a scoped single-use ticket.
      const ticket = await eventStreamTicket();
      const q = `ticket=${encodeURIComponent(ticket)}&worktree=${encodeURIComponent(wt())}`;
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
          const d = JSON.parse((ev as MessageEvent).data) as { name?: string; sessionId?: string; needsApproval?: boolean };
          if (d.sessionId && d.sessionId !== session) return; // another session's turn
          if (d.name) setLiveTool(d.needsApproval ? `${d.name} - waiting for you` : d.name);
        } catch { /* ignore */ }
      });
      // An `ask` tool the agent wants to run: its card appears at once. The
      // server owns the request; the chat column's poll is the catch-up for
      // anything a disconnected stream missed.
      es.addEventListener("approval", (ev) => {
        try {
          const d = JSON.parse((ev as MessageEvent).data) as { request?: ApprovalRequest };
          if (d.request) noteApproval(d.request);
        } catch { /* ignore */ }
      });
      es.addEventListener("approval-resolved", (ev) => {
        try {
          const d = JSON.parse((ev as MessageEvent).data) as { id?: string };
          if (d.id) resolveApproval(d.id);
        } catch { /* ignore */ }
      });
      es.onopen = () => { esRetries = 0; void refreshApprovals(); };
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
    void fetchRuntimePause();
  });
  const closeFile = (f: string) => {
    setOpenFiles((fs) => {
      const next = fs.filter((x) => x !== f);
      if (activeFile() === f && next.length) setActiveFile(next[next.length - 1]);
      return next;
    });
  };
  // Tab-strip menu actions (VS Code parity).
  const closeOtherFiles = (keep: string): void => {
    setOpenFiles(() => [keep]);
    setActiveFile(keep);
  };
  const closeAllFiles = (): void => { setOpenFiles([]); };

  const send = async () => {
    const text = input().trim();
    if (!text || sending()) return;
    // This turn belongs to the session it was typed in. The answer is appended
    // only if that is still the session on screen; otherwise it is already in
    // that session's history, which loads when the user returns to it.
    const sid = session;
    const thinkMatch = text.match(/\/think:(low|medium|high|max)/i);
    const lvl = thinkMatch ? thinkMatch[1].toLowerCase() : think();
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setLiveText("");
    setLiveThink("");
    setLiveTool("");
    setSendingFor(sid, true);
    // A stream that gave up earlier must not stay dead: this turn's tokens
    // and approval cards arrive on it.
    if (!es || es.readyState === EventSource.CLOSED) void openEventStream();
    try {
      // A turn may wait on the user's approval for minutes: the proxy is asked
      // to wait that long for this one call.
      const res = await apiFetch("/api/acp/session/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ params: { sessionId: sid, text, think: lvl, model: model() || undefined, numPredict: tokens(), autoApprove: autoApprove(), worktree: wt(), approvals: "interactive" } }),
        timeoutMs: 16 * 60_000,
      });
      const data = (await res.json().catch(() => ({}))) as { reply?: string; hint?: string; error?: string; thinking?: string; model?: string; tokens?: number; attempts?: number; budget?: number };
      if (session !== sid) return;
      // A failed call used to render as an empty "echo" bubble.
      if (!res.ok || typeof data.reply !== "string") {
        setMessages((m) => [...m, { role: "assistant", text: `— error —\n${data.error ?? `the runtime answered ${res.status}`}` }]);
        return;
      }
      const esc = data.attempts && data.attempts > 1 ? ` · escalated x${data.attempts} to ${data.budget} tok` : "";
      const label = data.model ? `${data.model}${data.tokens ? ` · ${data.tokens} tok` : ""}${esc}` : "echo";
      setMessages((m) => [...m, { role: "assistant", text: `— ${label} —\n${data.reply}${data.hint ? `\n\n${data.hint}` : ""}${data.thinking ? `\n\n[thinking]\n${data.thinking}` : ""}` }]);
    } catch {
      if (session === sid) setMessages((m) => [...m, { role: "assistant", text: `— error —\nserver unreachable - is the runtime running?` }]);
    } finally {
      setSendingFor(sid, false);
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
  // Persisted: a session switch reloads the window, and in-memory-only hiding
  // meant every hidden tab came straight back.
  const loadHiddenTabs = (): Set<string> => {
    try {
      const raw = localStorage.getItem("ehc.hiddenTabs");
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch { return new Set<string>(); }
  };
  const persistHiddenTabs = (s: Set<string>): void => {
    try { localStorage.setItem("ehc.hiddenTabs", JSON.stringify([...s])); } catch { /* private mode */ }
  };
  const [hiddenTabs, setHiddenTabs] = createSignal<Set<string>>(loadHiddenTabs());
  const hideTab = (id: string): void => {
    const next = new Set(hiddenTabs()).add(id);
    persistHiddenTabs(next);
    setHiddenTabs(next);
  };
  const unhideAllTabs = (): void => { persistHiddenTabs(new Set<string>()); setHiddenTabs(new Set<string>()); void refreshSessionTabs(); };

  const refreshSessionTabs = async (): Promise<void> => {
    try {
      const list = await apiJson<Array<{ id: string; title: string; messageCount: number; lastActivity?: string | null; worktree?: string }>>("/api/sessions");
      const ordered = [...list].sort((a, b) => (b.lastActivity ?? b.id).localeCompare(a.lastActivity ?? a.id));
      // Adopt the session row's real worktree directory (never the session id).
      const mineRow = list.find((s) => s.id === session);
      if (mineRow?.worktree) setWt(mineRow.worktree);
      setSessionTabs(() => {
        const mine = ordered.find((s) => s.id === session);
        const cur = mine ?? { id: session, title: `session ${session.slice(0, 6)}`, messageCount: 0 };
        const rest = ordered.filter((s) => s.id !== session);
        return [cur, ...rest]
          // the window's own session always keeps its tab, whatever was hidden elsewhere
          .filter((s) => s.id === session || !hiddenTabs().has(s.id))
          .map((s) => ({ id: s.id, title: s.title, messageCount: s.messageCount ?? 0 }));
      });
    } catch { /* strip falls back to just the current tab */ }
  };

  const closeSessionTab = (id: string): void => {
    if (id === session) { toast("the current session cannot be hidden - switch to another first", "warn"); return; }
    hideTab(id);
    setSessionTabs((ts) => ts.filter((t) => t.id !== id));
  };

  const openSession = (id: string): void => {
    if (id === session) return;
    // In-place switch: no reload. Terminal PTY and Monaco content remount via
    // the sessionVersion keyed wrapper.
    switchSession(id);
  };

  // Session-strip context menu: the actions a tab already implies (switch,
  // hide) plus fork/checkpoint without hunting through the Sessions panel.
  const forkSession = async (id: string): Promise<void> => {
    try {
      const r = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = (await r.json()) as { sessionId?: string; error?: string };
      // The server names the new session `sessionId` (the panel reads it right;
      // this menu read `id` and reported every fork as failed).
      const forked = d.sessionId;
      if (forked) { toast(`forked ${id.slice(0, 10)} -> ${forked.slice(0, 10)}`, "ok"); void refreshSessionTabs(); }
      else toast(`fork failed: ${d.error ?? "?"}`, "error");
    } catch { toast("fork failed - server unreachable", "error"); }
  };
  const sessionMenu = (ev: MouseEvent, t: SessionTab): void => {
    const cur = t.id === session;
    openContextMenu(ev, [
      ...(!cur ? [{ label: "Switch to this session", action: () => openSession(t.id) }] : []),
      { label: "Fork session", action: () => void forkSession(t.id) },
      { label: "Copy session id", action: () => void navigator.clipboard.writeText(t.id) },
      { separator: true, label: "", action: () => {} },
      ...(cur ? [{ label: "Checkpoint", action: () => void checkpointSession() }] : []),
      { label: "Session log", action: () => toggleSessionLog() },
      ...(!cur ? [{ label: "Hide tab (session preserved)", action: () => closeSessionTab(t.id) }] : []),
    ]);
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
  // "+" opens a brand-new empty session in THIS window. Forks live in the
  // Sessions panel where they are labeled - a fork-per-click chain produced a
  // pile of "session (fork) (fork)" junk nobody asked for.
  const newSessionHere = async (): Promise<void> => {
    try {
      const r = await apiFetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = (await r.json()) as { id?: string; error?: string };
      if (!d.id) {
        const why = `could not create session: ${d.error ?? "?"}`;
        toast(why, "error");
        setMessages((m) => [...m, { role: "tool", text: why }]);
        return;
      }
      toast(`new session ${d.id.slice(0, 10)} — switched THIS window`, "ok");
      switchSession(d.id);
    } catch { toast("could not create session - server unreachable", "error"); }
  };

  const checkpointSession = async () => {
    try {
      const r = await apiFetch(`/api/sessions/${encodeURIComponent(session)}/checkpoints`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "manual checkpoint" }) });
      const d = (await r.json()) as { seq?: number; error?: string };
      toast(d.seq !== undefined ? `checkpoint saved at message ${d.seq}` : `checkpoint failed: ${d.error ?? "?"}`, d.seq !== undefined ? "ok" : "error");
      if (d.seq === undefined) setMessages((m) => [...m, { role: "tool", text: `checkpoint failed: ${d.error ?? "?"}` }]);
    } catch { toast("checkpoint failed — server unreachable", "error"); }
  };

  const devPreview = typeof window !== "undefined" && !window.eventhorizon;
  // ---- Pop-out routes: render only the popped-out panel ----
  if (popoutKind === "camera") {
    return (
      <div class="popout-root">
        <CameraWindow />
      </div>
    );
  }
  if (popoutKind === "terminal") {
    return (
      <div class="popout-root">
        <ContextMenu />
        <Terminal worktree={wt()} />
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
          session={sessionSig()}
          compact
        />
      </div>
    );
  }

  return (
    <div class="workbench" style={{ "grid-template-columns": cols(), "grid-template-rows": rows() }}>
      <ShaderBackground intensity={shaderIntensity} />
      <Show when={approvalsMenu()}><ApprovalsMenu onClose={() => setApprovalsMenu(false)} /></Show>
      <header class="ehc-chat-tabs">
        <span class="ehc-brand" title="Event Horizon Code">Event Horizon</span>
        <div class="chat-tabstrip">
          <div class="chat-tabs-scroll" role="tablist" aria-label="Agent sessions">
            <For each={sessionTabs()}>
              {(t) => (
                <div
                  class="chat-tab"
                  classList={{ "chat-tab-on": t.id === sessionSig() }}
                  role="tab"
                  aria-selected={t.id === sessionSig()}
                  title={`${t.title} (${t.messageCount} messages) - window #${t.id.slice(0, 10)}`}
                  onClick={() => openSession(t.id)}
                  onContextMenu={(ev) => sessionMenu(ev, t)}
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
            title="New empty session (switches this window)"
            aria-label="New empty session"
            onClick={() => void newSessionHere()}
          >+</button>
        </div>
      </header>

      <ActivityBar open={open} toggle={toggle} sessionsActive={sessionsActive} onSessions={toggleSessionLog} />

      <Show when={open().sidebar}>
        <Splitter direction="col" class="ehc-split-v1" onDelta={sidebarLeftEdge} onEnd={persistLayout} />
        <section class="sidebar">
          <FileTree onSelect={openFile} root={wt} />
        </section>
      </Show>

      <Splitter direction="col" class="ehc-split-v2" onDelta={sidebarRightEdge} onEnd={persistLayout} />

      <section class="main-area">
        <Tabs files={openFiles} active={activeFile} onSelect={setActiveFile} onClose={closeFile} onCloseOthers={closeOtherFiles} onCloseAll={closeAllFiles} root={wt} />
        <Show keyed when={sessionVersion()}>
          <MonacoMount file={activeFile()} worktree={wt()} />
        </Show>
        <Show when={open().panels}>
          <div class="panels">
            <div
              class="panel-tabs"
              role="tablist"
              ref={panelTabsRef}
              // A vertical wheel scrolls the strip horizontally while it has
              // room to move, so tabs off the edge stay reachable.
              onWheel={(e) => {
                const el = e.currentTarget;
                if (el.scrollWidth <= el.clientWidth) return;
                if ((e.deltaY > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1) || (e.deltaY < 0 && el.scrollLeft > 0)) el.scrollLeft += e.deltaY;
              }}
            >
              <For each={PANELS}>{(p, i) => (
                <button
                  class="panel-tab"
                  classList={{ "panel-tab-on": panelTab() === i() }}
                  role="tab"
                  onClick={(e) => { setPanelTab(i()); localStorage.setItem("ehc.panelTab", String(i())); e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest" }); }}
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
          session={sessionSig()}
          sending={sending} liveText={liveText} liveThink={liveThink} liveTool={liveTool}
        />
      </Show>

      <Show when={open().terminal}>
        <Splitter direction="row" class="ehc-split-h1" onDelta={termTopEdge} onEnd={persistLayout} />
        <footer class="terminal">
          <div class="term-wrap">
            <div class="ehc-toolbar">
              <span>Terminal</span>
              <button title="Pop out to window" onClick={() => void popoutWindow("terminal", session, wt())}>⧉</button>
            </div>
            <Show keyed when={sessionVersion()}>
              <Terminal worktree={wt()} />
            </Show>
          </div>
        </footer>
      </Show>

      <StatusBar session={sessionSig()} file={activeFile} worktree={wt} model={model} think={think} shader={() => SHADER_STEPS[shaderIdx()].label} onShader={cycleShader} paused={agentsPaused} onPause={toggleAgentsPaused} approvals={() => pendingApprovals().length} grants={() => activeGrants().length} onApprovals={() => setApprovalsMenu((v) => !v)} />
      <Toasts toasts={toasts} dismiss={dismissToast} />
      <ContextMenu />
      <Show when={devPreview}>
        <div class="dev-preview-banner" role="alert">
          <strong>Dev preview (browser)</strong>
          <span>This page cannot reach the local server — its buttons are inert by design. The working app is the <em>Event Horizon Code</em> window (Alt+Tab to it, or relaunch <code>npm run dev</code>).</span>
        </div>
      </Show>
    </div>
  );
}
