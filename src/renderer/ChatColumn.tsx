// Event Horizon Code - Chat column (shared by main workbench and chat pop-out)
//
// Message protocol with App: messages[] alternates user (even index) and
// assistant (odd). Assistant text is the server's reply format:
//   "- tool steps (N) -\n<steps>\n\n- answer -\n<reply>\n\n[thinking]\n..."
// which this component parses into structured blocks: a collapsible tool-step
// ledger, the markdown answer, and a collapsible thinking section.

import { createSignal, For, Show, onMount, onCleanup, createMemo, createEffect } from "solid-js";
import { apiJson, apiFetch } from "./api";
import { openContextMenu } from "./ContextMenu";
import { whenVoicesReady, refreshSystemVoices, pickDefaultVoice, speakSystem, speakViaServer, stopSpeaking, stopAudio, speechSupported, type SpeechVoice } from "./speech";

export type ChatMsg = { role: "user" | "assistant" | "tool"; text: string };

type Parsed = { label: string; steps: string[]; answer: string; thinking: string };

function parseAssistant(raw: string): Parsed {
  const p: Parsed = { label: "", steps: [], answer: raw, thinking: "" };
  let rest = raw;
  const labelMatch = rest.match(/^— ([^\n]+) —\n/);
  if (labelMatch) { p.label = labelMatch[1]; rest = rest.slice(labelMatch[0].length); }
  const stepsMatch = rest.match(/^— tool steps \((\d+)\) —\n([\s\S]*?)\n\n— answer —\n/);
  if (stepsMatch) {
    p.steps = stepsMatch[2].split("\n\n").filter(Boolean);
    rest = rest.slice(stepsMatch[0].length);
  } else {
    const ansMatch = rest.match(/^— answer —\n/);
    if (ansMatch) rest = rest.slice(ansMatch[0].length);
  }
  const thinkMatch = rest.match(/\n\n\[thinking\]\n([\s\S]*)$/);
  if (thinkMatch) {
    p.thinking = thinkMatch[1].trim();
    rest = rest.slice(0, thinkMatch.index);
  }
  p.answer = rest.trim();
  return p;
}

// Markdown-lite, injection-safe: build JSX nodes, never innerHTML.
// Supports fenced code blocks, inline `code`, **bold**, and line breaks.
function InlineCode(p: { text: string }) {
  const parts = createMemo(() => p.text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean));
  return (
    <For each={parts()}>
      {(seg) => {
        if (seg.startsWith("`") && seg.endsWith("`") && seg.length > 2) return <code class="md-code">{seg.slice(1, -1)}</code>;
        if (seg.startsWith("**") && seg.endsWith("**") && seg.length > 4) return <strong>{seg.slice(2, -2)}</strong>;
        return <>{seg}</>;
      }}
    </For>
  );
}

// Line-level blocks: headings, bullets, numbered lists, rules, paragraphs.
function TextBlock(p: { text: string }) {
  const lines = createMemo(() => p.text.split("\n"));
  return (
    <For each={lines()}>
      {(line) => {
        const h = line.match(/^(#{1,3})\s+(.*)$/);
        if (h) {
          const cls = h[1].length === 1 ? "md-h1" : h[1].length === 2 ? "md-h2" : "md-h3";
          return <div class={cls}><InlineCode text={h[2]} /></div>;
        }
        const ul = line.match(/^\s*[-*]\s+(.*)$/);
        if (ul) return <div class="md-li"><span class="md-bullet">•</span><span><InlineCode text={ul[1]} /></span></div>;
        const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (ol) return <div class="md-li"><span class="md-bullet md-num">{ol[1]}.</span><span><InlineCode text={ol[2]} /></span></div>;
        if (/^\s*(---|\*\*\*)\s*$/.test(line)) return <hr class="md-hr" />;
        if (!line.trim()) return <div class="md-gap" />;
        return <div class="md-p"><InlineCode text={line} /></div>;
      }}
    </For>
  );
}

function Markdown(p: { text: string }) {
  const blocks = createMemo(() => p.text.split(/```/));
  return (
    <For each={blocks()}>
      {(block, i) => (
        <Show when={block.trim().length > 0} fallback={null}>
          <Show
            when={i() % 2 === 1}
            fallback={<div class="md-body"><TextBlock text={block} /></div>}
          >
            {(() => {
              const nl = block.indexOf("\n");
              const hasLang = nl > 0 && nl < 40;
              const code = hasLang ? block.slice(nl + 1) : block;
              return (
                <div class="md-codeblock">
                  <Show when={hasLang}><span class="md-lang">{block.slice(0, nl).trim()}</span></Show>
                  <pre><code>{code.replace(/\n$/, "")}</code></pre>
                </div>
              );
            })()}
          </Show>
        </Show>
      )}
    </For>
  );
}

function ToolSteps(p: { steps: string[] }) {
  const [open, setOpen] = createSignal(false);
  const okCount = p.steps.filter((s) => s.startsWith("OK")).length;
  return (
    <div class="tool-steps">
      <button class="tool-steps-toggle" onClick={() => setOpen(!open())}>
        <span class="tool-steps-count">{okCount}/{p.steps.length} tool calls</span>
        <span class="tool-steps-chevron">{open() ? "▾" : "▸"}</span>
      </button>
      <Show when={open()}>
        <For each={p.steps}>{(s) => <pre class={s.startsWith("OK") ? "step-ok" : "step-fail"}>{s}</pre>}</For>
      </Show>
    </div>
  );
}

function Thinking(p: { text: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="thinking">
      <button class="tool-steps-toggle" onClick={() => setOpen(!open())}>
        <span class="tool-steps-count">thinking</span>
        <span class="tool-steps-chevron">{open() ? "▾" : "▸"}</span>
      </button>
      <Show when={open()}><pre class="thinking-body">{p.text}</pre></Show>
    </div>
  );
}

const EXAMPLES = [
  "Summarize what this project does and where its entry points live",
  "Find every TODO or stub under src/ and list them in a table",
  "/think:high Review src/server/agentLoop.ts for race conditions",
];

export default function ChatColumn(props: {
  messages: () => ChatMsg[];
  input: () => string;
  setInput: (v: string) => void;
  onSend: () => void;
  models: () => string[];
  model: () => string;
  setModel: (v: string) => void;
  think: () => string;
  setThink: (v: string) => void;
  tokens: () => number;
  setTokens: (n: number) => void;
  autoApprove: () => boolean;
  setAutoApprove: (v: boolean) => void;
  sending?: () => boolean;
  liveText?: () => string;
  liveThink?: () => string;
  liveTool?: () => string;
  compact?: boolean; // pop-out variant: hide detonation footer
}) {
  let listRef: HTMLDivElement | undefined;
  let taRef: HTMLTextAreaElement | undefined;
  const [slashOpen, setSlashOpen] = createSignal(false);
  const [slashIdx, setSlashIdx] = createSignal(0);

  // Slash commands: shown when the composer's current token starts with "/".
  const SLASH_COMMANDS = [
    { cmd: "/think:low", hint: "fastest - minimal reasoning" },
    { cmd: "/think:medium", hint: "balanced (default)" },
    { cmd: "/think:high", hint: "step by step, verify details" },
    { cmd: "/think:max", hint: "thorough, checks its work" },
  ];
  const slashMatches = createMemo(() => {
    const v = props.input();
    const m = v.match(/(^|\s)(\/[a-z:]*)$/i);
    if (!m) return [];
    const frag = m[2].toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(frag));
  });

  const applySlash = (cmd: string): void => {
    const v = props.input();
    const m = v.match(/(^|\s)(\/[a-z:]*)$/i);
    props.setInput(m ? v.slice(0, m.index) + m[1] + cmd + " " : `${cmd} ${v}`);
    setSlashOpen(false);
    taRef?.focus();
  };

  // Keep the newest message in view; auto-grow the composer.
  onMount(() => {
    const observer = new MutationObserver(() => { listRef?.scrollTo({ top: listRef.scrollHeight, behavior: "smooth" }); });
    if (listRef) observer.observe(listRef, { childList: true, subtree: true, characterData: true });
    onCleanup(() => observer.disconnect());
  });

  const grow = (): void => {
    if (!taRef) return;
    taRef.style.height = "auto";
    taRef.style.height = `${Math.min(taRef.scrollHeight, 180)}px`;
  };
  onMount(() => grow());

  const keydown = (e: KeyboardEvent): void => {
    const matches = slashMatches();
    if (matches.length && e.key === "ArrowDown") { e.preventDefault(); setSlashIdx((i) => (i + 1) % matches.length); return; }
    if (matches.length && e.key === "ArrowUp") { e.preventDefault(); setSlashIdx((i) => (i - 1 + matches.length) % matches.length); return; }
    if (matches.length && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
      e.preventDefault();
      applySlash(matches[Math.min(slashIdx(), matches.length - 1)].cmd);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      props.onSend();
      requestAnimationFrame(grow);
    }
    if (e.key === "Escape") setSlashOpen(false);
  };

  // Capability badges for the selected model (multimodal readiness at a glance).
  const [caps, setCaps] = createSignal<string[]>([]);
  const [capsNote, setCapsNote] = createSignal("");
  createEffect(() => {
    const m = props.model();
    if (!m) { setCaps([]); setCapsNote(""); return; }
    void (async () => {
      try {
        const d = await apiJson<{ capabilities: string[]; source: string; note?: string }>(`/api/models/capabilities?model=${encodeURIComponent(m)}`);
        setCaps(d.capabilities ?? []);
        setCapsNote(d.note ?? "");
      } catch { setCaps([]); }
    })();
  });
  const CAP_LABEL: Record<string, string> = { vision: "eyes", audio: "ears", tools: "tools", thinking: "thinking", completion: "", embedding: "embed", insert: "fim" };

  // ---- BYOK model quick-switch ----
  // When the selected model is byok:<provider>, fetch that endpoint's own
  // /models catalog (cached per provider) and offer a dropdown under the
  // model selector; picking one updates the provider's stored model on the
  // fly (the next turn uses it).
  const BYOK_PREFIX = "byok:";
  const byokProvider = () => (props.model().startsWith(BYOK_PREFIX) ? props.model().slice(BYOK_PREFIX.length) : "");
  const [byokCatalog, setByokCatalog] = createSignal<Record<string, string[]>>({});
  const [byokCurrent, setByokCurrent] = createSignal<Record<string, string>>({});
  const [byokNote, setByokNote] = createSignal("");
  let byokNoteTimer: ReturnType<typeof setTimeout> | undefined;
  const byokFlash = (msg: string) => { setByokNote(msg); clearTimeout(byokNoteTimer); byokNoteTimer = setTimeout(() => setByokNote(""), 6000); };
  createEffect(() => {
    const provider = byokProvider();
    if (!provider || byokCatalog()[provider]) return;
    void (async () => {
      try {
        const cat = await apiJson<{ ok: boolean; models?: string[]; error?: string }>(`/api/secrets/${encodeURIComponent(provider)}/models`);
        setByokCatalog((c) => ({ ...c, [provider]: cat.ok && Array.isArray(cat.models) ? cat.models : [] }));
      } catch { setByokCatalog((c) => ({ ...c, [provider]: [] })); }
      try {
        const st = await apiJson<{ providers?: Array<{ provider: string; model: string | null }> }>("/api/secrets/status");
        const row = st.providers?.find((p) => p.provider === provider);
        if (row) setByokCurrent((c) => ({ ...c, [provider]: row.model ?? "" }));
      } catch { /* status unavailable - the dropdown still lists the catalog */ }
    })();
  });
  const setByokModel = async (model: string) => {
    const provider = byokProvider();
    if (!provider || !model) return;
    try {
      const r = await apiFetch("/api/secrets", { method: "POST", body: JSON.stringify({ provider, model }) });
      const d = (await r.json()) as { ok: boolean; error?: string };
      if (!d.ok) { byokFlash(`failed: ${d.error ?? "?"}`); return; }
      setByokCurrent((c) => ({ ...c, [provider]: model }));
      byokFlash(`${provider}: model set to ${model} - the next turn uses it`);
    } catch { byokFlash("save failed - server unreachable"); }
  };

  // ---- speech: platform default adapter, with a swappable voice ----
  const [voices, setVoices] = createSignal<SpeechVoice[]>([]);
  const [voiceURI, setVoiceURI] = createSignal<string>(localStorage.getItem("ehc.ttsVoice") ?? "");
  const [ttsAdapter, setTtsAdapter] = createSignal<string>("");
  const [ttsNote, setTtsNote] = createSignal("");
  const [speaking, setSpeaking] = createSignal(false);
  const [autoSpeak, setAutoSpeak] = createSignal(localStorage.getItem("ehc.autoSpeak") === "1");

  // The toolbar's tool-step tally mirrors the latest assistant message: it tells
  // the user whether the agent acted this turn, at a glance, above the chat.
  const latestStepSummary = createMemo(() => {
    const msgs = props.messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "assistant") continue;
      const p = parseAssistant(msgs[i].text);
      if (p.steps.length) {
        return { total: p.steps.length, ok: p.steps.filter((s) => s.startsWith("OK")).length };
      }
      return null;
    }
    return null;
  });

  onMount(() => {
    void (async () => {
      const [vs, plan] = await Promise.all([
        whenVoicesReady(),
        apiJson<{ preferred: string; platform: string; defaultMode: string }>("/api/tts/voices").catch(() => null),
      ]);
      setVoices(vs);
      if (!voiceURI()) {
        const def = pickDefaultVoice(vs);
        if (def) setVoiceURI(def.id);
      }
      if (plan) {
        setTtsAdapter(plan.preferred);
        setTtsNote(plan.preferred === "system"
          ? `system voices (${vs.length} available)`
          : plan.defaultMode);
      }
    })();
  });

  const speak = async (text: string): Promise<void> => {
    const clean = text.replace(/```[\s\S]*?```/g, " code block ").replace(/[#*`>]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean) return;
    setSpeaking(true);
    try {
      // Windows default: OS voices (instant, no model). Otherwise the engine
      // adapter (Pocket TTS) via the server.
      if (ttsAdapter() === "system" || (ttsAdapter() === "" && speechSupported())) {
        const r = speakSystem(clean, { voiceURI: voiceURI() });
        if (!r.ok && ttsAdapter() !== "system") {
          const s = await speakViaServer(clean, { voice: voiceURI() });
          toastTts(s.ok ? "" : (s.error ?? "speech failed"));
        } else if (!r.ok) {
          toastTts(r.error ?? "speech failed");
        }
      } else {
        const s = await speakViaServer(clean, { voice: voiceURI() });
        if (!s.ok) toastTts(s.error ?? "speech failed");
      }
    } finally {
      // Give the utterance a moment before clearing the speaking flag.
      setTimeout(() => setSpeaking(false), 1200);
    }
  };
  const toastTts = (msg: string): void => {
    if (msg) window.dispatchEvent(new CustomEvent("ehc-toast", { detail: { text: msg, kind: "error" } }));
  };
  onCleanup(() => { stopSpeaking(); stopAudio(); });

  // Auto-speak preference: read each new assistant answer aloud once. History
  // that was replayed on mount is never re-spoken.
  let spokenCount = props.messages().length;
  createEffect(() => {
    const msgs = props.messages();
    if (msgs.length <= spokenCount) { spokenCount = msgs.length; return; }
    const last = msgs[msgs.length - 1];
    spokenCount = msgs.length;
    if (autoSpeak() && last.role === "assistant" && !props.sending?.()) {
      const p = parseAssistant(last.text);
      if ((p.answer ?? "").trim()) void speak(p.answer);
    }
  });

  // Right-click a message: copy (text / answer / full with thinking), quote it
  // into the composer, edit-and-resend your own turn, read an answer aloud.
  const msgMenu = (ev: MouseEvent, role: ChatMsg["role"], text: string, answer?: string): void => {
    const body = answer ?? text;
    const quote = (): void => {
      const cur = props.input();
      props.setInput(`${cur ? `${cur}\n` : ""}> ${body.replace(/\n/g, "\n> ")}\n`);
      taRef?.focus();
    };
    openContextMenu(ev, [
      { label: role === "assistant" ? "Copy answer" : "Copy", action: () => void navigator.clipboard.writeText(body) },
      ...(role === "assistant" && answer !== undefined ? [{ label: "Copy with thinking", action: () => void navigator.clipboard.writeText(text) }] : []),
      { label: "Quote into composer", action: quote },
      ...(role === "user" ? [{ label: "Edit & resend", action: () => { props.setInput(body); taRef?.focus(); } }] : []),
      ...(role === "assistant" ? [{ label: "Read aloud", action: () => void speak(body) }] : []),
    ]);
  };

  return (
    <aside class="chat">
      <div class="chat-toolbar" title="Model, capabilities, and tool activity this turn">
        <span class="chat-toolbar-title">Event Horizon</span>
        <span class="chat-toolbar-sep" />
        <span class="chat-toolbar-badge" title={`model: ${props.model() || "none"}${capsNote() ? ` (${capsNote()})` : ""}`}>{props.model() || "none"}</span>
        <span class="chat-toolbar-caps">
          <For each={caps().filter((c) => CAP_LABEL[c])}>
            {(c) => <span class={`cap-badge cap-${c}`}>{CAP_LABEL[c]}</span>}
          </For>
        </span>
        <span class="spacer" />
        <Show when={latestStepSummary()}>
          {(sum) => (
            <span class="chat-toolbar-badge chat-toolbar-badge-tools" title="tool calls this turn (OK / total)">
              {sum().ok}/{sum().total} tools
            </span>
          )}
        </Show>
      </div>
      <div class="chat-scroll" ref={listRef}>
        <Show
          when={props.messages().length > 0}
          fallback={
            <div class="chat-empty">
              <div class="chat-empty-glyph">&#9673;</div>
              <div class="chat-empty-title">Event Horizon agent</div>
              <div class="chat-empty-sub">Local models, real tools, your workspace. Pick a starting point:</div>
              <div class="chat-empty-examples">
                <For each={EXAMPLES}>{(ex) => <button class="example-chip" onClick={() => { props.setInput(ex); taRef?.focus(); requestAnimationFrame(grow); }}>{ex}</button>}</For>
              </div>
            </div>
          }
        >
          <For each={props.messages()}>
            {(m) => (
              <Show when={m.role === "assistant"} fallback={
                <Show when={m.role === "user"} fallback={<pre class="msg-tool" onContextMenu={(ev) => msgMenu(ev, "tool", m.text)}>{m.text.slice(0, 600)}</pre>}>
                  <div class="msg msg-user" onContextMenu={(ev) => msgMenu(ev, "user", m.text)}><Markdown text={m.text} /></div>
                </Show>
              }>
                {(() => {
                  const p = parseAssistant(m.text);
                  return (
                    <div class="msg msg-assistant" onContextMenu={(ev) => msgMenu(ev, "assistant", m.text, p.answer)}>
                      <Show when={p.label}><div class="msg-label">{p.label}</div></Show>
                      <Show when={p.steps.length > 0}><ToolSteps steps={p.steps} /></Show>
                      <div class="msg-answer"><Markdown text={p.answer} /></div>
                      <Show when={p.thinking}><Thinking text={p.thinking} /></Show>
                      <div class="msg-actions">
                        <button class="copy-btn" title="Copy answer" onClick={() => void navigator.clipboard.writeText(p.answer)}>copy</button>
                        <button class="copy-btn" title="Read aloud" onClick={() => void speak(p.answer)}>{speaking() ? "stop" : "speak"}</button>
                      </div>
                    </div>
                  );
                })()}
              </Show>
            )}
          </For>
        </Show>
        <Show when={props.sending?.()}>
          <Show
            when={props.liveText?.()}
            fallback={
              <div class="msg msg-working">
                <span class="working-dot" />
                <span>{props.liveTool?.() ? `running ${props.liveTool?.()}...` : <>working<span class="working-ellipsis" /></>}</span>
              </div>
            }
          >
            <div class="msg msg-assistant msg-live">
              <Show when={props.liveThink?.()}>
                <div class="live-think" title="model reasoning (live)">{props.liveThink?.()?.slice(-400)}</div>
              </Show>
              <div class="msg-answer"><Markdown text={props.liveText?.() ?? ""} /></div>
              <span class="live-caret" />
            </div>
          </Show>
        </Show>
      </div>

      <Show when={slashMatches().length > 0}>
        <div class="slash-menu">
          <For each={slashMatches()}>
            {(c, i) => (
              <button
                class="slash-item"
                classList={{ "slash-item-on": i() === Math.min(slashIdx(), slashMatches().length - 1) }}
                onMouseDown={(e) => { e.preventDefault(); applySlash(c.cmd); }}
              >
                <span class="slash-cmd">{c.cmd}</span>
                <span class="slash-hint">{c.hint}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <div class="composer">
        <textarea
          ref={taRef}
          rows={1}
          value={props.input()}
          onInput={(e) => { props.setInput(e.target.value); setSlashOpen(true); setSlashIdx(0); grow(); }}
          onKeyDown={keydown}
          placeholder="Describe the task...  (/think:high to raise reasoning)"
          class="composer-input"
        />
        <button class="send-btn" disabled={props.sending?.()} onClick={() => { props.onSend(); requestAnimationFrame(grow); }}>Send</button>
      </div>
      <div class="model-row">
        <span>model</span>
        <select value={props.model()} onChange={(e) => props.setModel(e.target.value)}>
          <option value="">(none - echo)</option>
          <For each={props.models()}>{(m) => <option value={m}>{m.startsWith("byok:") ? `BYOK - ${m.slice(5)}` : m}</option>}</For>
        </select>
        <span>think</span>
        <select value={props.think()} onChange={(e) => props.setThink(e.target.value)}>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="max">max</option>
        </select>
      </div>
      <Show when={byokProvider()}>
        <div class="byok-row">
          <span>byok models</span>
          <Show
            when={(byokCatalog()[byokProvider()] ?? []).length > 0}
            fallback={<span class="session-meta">{(byokCatalog()[byokProvider()] ?? []).length === 0 && byokCatalog()[byokProvider()] ? "the endpoint returned no model catalog" : "fetching the endpoint's model catalog..."}</span>}
          >
            <select value={byokCurrent()[byokProvider()] ?? ""} onChange={(e) => void setByokModel(e.target.value)}>
              <For each={byokCatalog()[byokProvider()]}>{(m) => <option value={m}>{m}{m === byokCurrent()[byokProvider()] ? "  <- current" : ""}</option>}</For>
            </select>
            <span class="session-meta">{byokNote()}</span>
          </Show>
        </div>
      </Show>
      <div class="opts-row">
        <span title="Output token budget - reasoning models spend this on thinking first; the harness auto-doubles it and forces a conclusion if exhausted.">tokens</span>
        <input
          type="number" min="64" max="8192" step="128"
          value={props.tokens()}
          onChange={(e) => props.setTokens(Number(e.target.value))}
          class="ehc-tokens"
        />
        <label class="ehc-auto" title="Let the agent run edit/write/bash tools without asking each time (read/ls/grep/glob are always allowed).">
          <input type="checkbox" checked={props.autoApprove()} onChange={(e) => props.setAutoApprove(e.target.checked)} />
          auto-approve tools
        </label>
        <label class="ehc-auto" title="Read every reply aloud using the selected speech adapter.">
          <input type="checkbox" checked={autoSpeak()} onChange={(e) => { setAutoSpeak(e.target.checked); localStorage.setItem("ehc.autoSpeak", e.target.checked ? "1" : "0"); }} />
          speak replies
        </label>
      </div>
      {/* Voice picker: shown once we know the plan. The OS voice list can be
          empty (Chromium populates it late), so the row stays usable with a
          default entry and a refresh. */}
      <Show when={ttsAdapter() !== "" || voices().length > 0}>
        <div class="voice-row" title={`speech: ${ttsAdapter() || "auto"} - ${ttsNote()}`}>
          <span class="session-meta">voice</span>
          <select
            value={voiceURI()}
            onChange={(e) => { setVoiceURI(e.target.value); localStorage.setItem("ehc.ttsVoice", e.target.value); }}
          >
            <Show when={voices().length === 0}>
              <option value="">{ttsAdapter() === "system" ? "(system default)" : "(adapter default voice)"}</option>
            </Show>
            <For each={voices()}>{(v) => <option value={v.id}>{v.name} ({v.lang})</option>}</For>
          </select>
          <button class="voice-test" title="Re-read the OS voice list" onClick={() => { const vs = refreshSystemVoices(); if (vs.length) setVoices(vs); }}>reload</button>
          <button class="voice-test" onClick={() => void speak("Event Horizon online. Speech adapter ready.")}>test</button>
        </div>
      </Show>
    </aside>
  );
}
