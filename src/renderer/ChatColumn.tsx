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
  // ---- Speech to text (composer mic) ----
  // Press the mic: records from the selected input (MediaRecorder -> webm).
  // Press again: stops, converts to 16 kHz mono WAV in-page, POSTs it to
  // /api/sensory/transcribe (whisper.cpp, on this machine) and inserts the
  // transcript into the composer - it is never auto-sent. The level meter and
  // the clock show the capture is live; recording stops by itself at the cap.
  type SttPhase = "idle" | "recording" | "transcribing";
  const STT_MAX_SECS = 60;
  const [sttPhase, setSttPhase] = createSignal<SttPhase>("idle");
  const [sttNote, setSttNote] = createSignal("");
  const [sttSecs, setSttSecs] = createSignal(0);
  const [sttLevel, setSttLevel] = createSignal(0);
  const [earsReady, setEarsReady] = createSignal<boolean | null>(null);
  let sttNoteTimer: ReturnType<typeof setTimeout> | undefined;
  let sttTicker: ReturnType<typeof setInterval> | undefined;
  let sttRec: MediaRecorder | null = null;
  let sttStream: MediaStream | null = null;
  let sttMeter: AudioContext | null = null;
  let sttAnalyser: AnalyserNode | null = null;
  let sttChunks: Blob[] = [];
  let sttStartedAt = 0;
  const sttFlash = (msg: string, ms = 8000) => {
    clearTimeout(sttNoteTimer);
    setSttNote(msg);
    sttNoteTimer = setTimeout(() => setSttNote(""), ms);
  };
  const sttClock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // Mic picker: users with several inputs choose one; "default" is the OS
  // default. Entries without a deviceId are Chromium's pre-permission
  // placeholders, not devices. The choice is remembered, like the TTS voice.
  type MicDev = { id: string; label: string };
  // "" means the OS default ("default mic"). Chromium gives the OS's default
  // and communications endpoints the ids "default" and "communications", so
  // they are ordinary choices here and "" can never collide with a real id.
  const MIC_KEY = "ehc.micDeviceId";
  // Chromium labels Windows endpoints "Default - Microphone (X) (046d:0aaa)";
  // the picker keeps the role and the product, drops the ids.
  const prettyMic = (raw: string, i: number): string =>
    raw.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "").replace(/^Default\s*-\s*/i, "Default · ").replace(/^Communications\s*-\s*/i, "Comms · ") || `Microphone ${i + 1}`;
  const [micDevices, setMicDevices] = createSignal<MicDev[]>([]);
  const [micSel, setMicSel] = createSignal(localStorage.getItem(MIC_KEY) ?? "");
  const chooseMic = (id: string): void => {
    setMicSel(id);
    try { localStorage.setItem(MIC_KEY, id); } catch { /* storage unavailable */ }
  };
  async function refreshMicDevices(): Promise<void> {
    try {
      const inputs: MicDev[] = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "audioinput" && d.deviceId)
        .map((d, i) => ({ id: d.deviceId, label: prettyMic(d.label, i) }));
      // Reuse the row objects of unchanged devices so the picker's options are
      // not torn down and rebuilt on every refresh.
      setMicDevices((prev) => inputs.map((d) => prev.find((p) => p.id === d.id && p.label === d.label) ?? d));
      // A remembered device that is gone (unplugged) falls back to the default.
      if (inputs.length && micSel() && !inputs.some((m) => m.id === micSel())) chooseMic("");
    } catch { /* enumeration failing is fine - the mic button reports it on press */ }
  }
  // whisper.cpp present? Asked on mount for the button's look and again at
  // press time, so installing it while the app is open needs no restart.
  const ears = async (): Promise<boolean> => {
    try {
      const s = await apiJson<{ ears?: { ready?: boolean } }>("/api/sensory/status");
      setEarsReady(Boolean(s.ears?.ready));
    } catch { setEarsReady(null); }
    return earsReady() === true;
  };
  onMount(() => {
    void refreshMicDevices();
    void ears();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMicDevices);
    // whisper.cpp installed by hand while the app was open: re-check on focus.
    window.addEventListener("focus", ears);
  });
  onCleanup(() => {
    navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMicDevices);
    window.removeEventListener("focus", ears);
  });

  // Secondary settings (token budget, auto-approve, speech) fold away so the
  // composer stays compact on a small screen. What they change stays visible
  // as flags on the model row, so a folded-away "auto-approve" is never a
  // surprise.
  const [optsOpen, setOptsOpen] = createSignal(localStorage.getItem("ehc.composerOptions") === "1");
  const toggleOpts = (): void => {
    setOptsOpen((v) => !v);
    try { localStorage.setItem("ehc.composerOptions", optsOpen() ? "1" : "0"); } catch { /* storage unavailable */ }
  };

  function encodeWav(samples: Int16Array): Uint8Array {
    const dataSize = samples.length * 2;
    const buf = new Uint8Array(44 + dataSize);
    const dv = new DataView(buf.buffer);
    buf.set([0x52, 0x49, 0x46, 0x46], 0); dv.setUint32(4, 36 + dataSize, true); buf.set([0x57, 0x41, 0x56, 0x45], 8); // RIFF / WAVE
    buf.set([0x66, 0x6d, 0x74, 0x20], 12); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); // fmt, PCM, mono
    dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    buf.set([0x64, 0x61, 0x74, 0x61], 36); dv.setUint32(40, dataSize, true);
    for (let i = 0; i < samples.length; i++) dv.setInt16(44 + i * 2, samples[i]!, true);
    return buf;
  }
  function bytesToBase64(bytes: Uint8Array): string {
    let s = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    return btoa(s);
  }
  // Decode the capture straight to 16 kHz (the platform resampler does the
  // rate conversion) and mix down to mono 16-bit - what transcribe() expects.
  async function sttToWav16kMono(blob: Blob): Promise<Int16Array> {
    const off = new OfflineAudioContext(1, 1, 16000);
    const data = await off.decodeAudioData(await blob.arrayBuffer());
    const chs = Array.from({ length: data.numberOfChannels }, (_, c) => data.getChannelData(c));
    const out = new Int16Array(data.length);
    for (let i = 0; i < data.length; i++) {
      let sum = 0;
      for (const c of chs) sum += c[i] ?? 0;
      out[i] = Math.max(-32768, Math.min(32767, Math.round((sum / chs.length) * 32767)));
    }
    return out;
  }

  // Frees the capture (mic indicator off, meter closed). Safe to repeat.
  function sttRelease(): void {
    clearInterval(sttTicker); sttTicker = undefined;
    const meter = sttMeter; sttMeter = null; sttAnalyser = null;
    if (meter) void meter.close().catch(() => { /* already closed */ });
    const stream = sttStream; sttStream = null;
    stream?.getTracks().forEach((t) => t.stop());
    setSttLevel(0);
  }
  function sttAttachMeter(stream: MediaStream): void {
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      sttMeter = ctx; sttAnalyser = analyser;
    } catch { /* the meter is optional */ }
  }
  function sttReadLevel(): number {
    if (!sttAnalyser) return 0;
    const buf = new Uint8Array(sttAnalyser.fftSize);
    sttAnalyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]! - 128));
    return Math.min(100, Math.round((peak / 128) * 100));
  }

  const sttStart = async (): Promise<void> => {
    try {
      const gUM: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      // Only a device that is in the picker right now may be requested; an
      // empty or stale id would make getUserMedia fail with a constraint error.
      const pick = micSel();
      if (pick && micDevices().some((m) => m.id === pick)) gUM.deviceId = { exact: pick };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: gUM });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      sttStream = stream; sttRec = rec; sttChunks = []; sttStartedAt = Date.now();
      rec.ondataavailable = (e) => { if (e.data.size > 0) sttChunks.push(e.data); };
      // Second press (or the cap) calls stop(); the final chunk lands first.
      rec.onstop = () => { sttRelease(); void sttFinish(); };
      rec.start();
      sttAttachMeter(stream);
      setSttPhase("recording"); setSttSecs(0); setSttLevel(0);
      sttTicker = setInterval(() => {
        const elapsed = (Date.now() - sttStartedAt) / 1000;
        setSttLevel(sttReadLevel());
        setSttSecs(Math.floor(elapsed));
        if (elapsed >= STT_MAX_SECS) sttToggle();
      }, 200);
      // Labels only exist once capture permission has been granted.
      void refreshMicDevices();
    } catch (e) {
      sttRelease();
      setSttPhase("idle");
      const err = e as { name?: string; message?: string };
      const why = err?.name === "NotAllowedError" ? "access was denied - allow microphones for this app in Windows Settings > Privacy & security > Microphone"
        : err?.name === "NotFoundError" ? "no microphone was found on this machine"
        : err?.name === "OverconstrainedError" ? "the selected microphone is not available - pick another next to the mic button"
        : String(err?.message ?? err).slice(0, 140);
      sttFlash(`Microphone unavailable (${err?.name ?? "error"}): ${why}`, 12000);
    }
  };

  const sttFinish = async (): Promise<void> => {
    const chunks = sttChunks; sttChunks = [];
    const type = sttRec?.mimeType || "audio/webm";
    sttRec = null;
    const secs = (Date.now() - sttStartedAt) / 1000;
    if (!chunks.length || secs < 0.4) {
      setSttPhase("idle");
      sttFlash("Nothing was captured - press the mic, speak, then press it again to transcribe");
      return;
    }
    setSttPhase("transcribing");
    sttFlash("Transcribing…", 120_000);
    try {
      const wav = encodeWav(await sttToWav16kMono(new Blob(chunks, { type })));
      const language = localStorage.getItem("ehc.sttLanguage") || undefined;
      const model = localStorage.getItem("ehc.sttModel") || undefined;
      const r = await apiFetch("/api/sensory/transcribe", { method: "POST", body: JSON.stringify({ audioBase64: bytesToBase64(wav), language, model }) });
      const d = (await r.json()) as { ok: boolean; text?: string; error?: string };
      if (d.ok && d.text?.trim()) {
        const cur = props.input();
        props.setInput(cur ? cur.trimEnd() + " " + d.text.trim() : d.text.trim());
        grow();
        taRef?.focus();
        sttFlash("Transcript inserted - edit it if needed, then press Enter to send");
      } else {
        sttFlash(d.error ? `Transcription failed: ${String(d.error).slice(0, 180)}` : "No speech was detected in the recording");
      }
    } catch (e) {
      sttFlash(`Transcription failed: ${String((e as Error)?.message ?? e).slice(0, 180)}`);
    } finally {
      setSttPhase("idle");
    }
  };

  // Discard the recording without transcribing.
  const sttCancel = (): void => {
    const rec = sttRec;
    if (!rec) return;
    rec.onstop = null;
    sttChunks = [];
    try { if (rec.state !== "inactive") rec.stop(); } catch { /* already stopped */ }
    sttRec = null;
    sttRelease();
    setSttPhase("idle");
    sttFlash("Recording discarded");
  };

  const sttToggle = async (): Promise<void> => {
    const phase = sttPhase();
    if (phase === "transcribing") return;
    if (phase === "recording") {
      // Second press (or the 60 s cap): stop -> final chunk -> onstop -> sttFinish.
      setSttPhase("transcribing");
      try { sttRec?.state !== "inactive" && sttRec?.stop(); } catch { sttRelease(); setSttPhase("idle"); }
      return;
    }
    setSttPhase("transcribing"); // holds the button while the mic is being opened
    if (!(await ears())) {
      setSttPhase("idle");
      sttFlash("Speech-to-text needs whisper.cpp and a language model. The Sensory panel has optional downloads - nothing installs unless you click it.", 16000);
      // Take the user straight to where that lives.
      window.dispatchEvent(new CustomEvent("ehc:want-panel", { detail: { id: "sensory" } }));
      return;
    }
    await sttStart();
  };
  const sttTitle = () => earsReady() === false
    ? "Speech-to-text is not set up yet - click for how to enable it (optional download)"
    : sttPhase() === "recording"
      ? "Recording - click to stop and transcribe"
      : "Voice input: click to record from your microphone, click again to transcribe with whisper.cpp on this machine";
  // Never leave the microphone open if the composer goes away mid-recording.
  onCleanup(() => {
    clearTimeout(sttNoteTimer);
    const rec = sttRec;
    sttRec = null;
    if (rec) { rec.onstop = null; try { if (rec.state !== "inactive") rec.stop(); } catch { /* already stopped */ } }
    sttRelease();
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
          rows={3}
          value={props.input()}
          onInput={(e) => { props.setInput(e.target.value); setSlashOpen(true); setSlashIdx(0); grow(); }}
          onKeyDown={keydown}
          placeholder="Describe the task...  (/think:high to raise reasoning)"
          class="composer-input"
        />
        <div class="composer-tools">
          <button
            class="stt-btn"
            classList={{ "stt-btn-rec": sttPhase() === "recording", "stt-btn-off": earsReady() === false }}
            disabled={sttPhase() === "transcribing"}
            title={sttTitle()}
            aria-label={sttPhase() === "recording" ? "Stop recording and transcribe" : "Record a voice message"}
            onClick={() => void sttToggle()}
          >{sttPhase() === "recording" ? "■" : sttPhase() === "transcribing" ? "…" : "🎤"}</button>
          <Show when={sttPhase() === "recording"}>
            <span class="stt-level" title="Microphone level"><i style={{ width: `${sttLevel()}%` }} /></span>
            <span class="stt-clock">{sttClock(sttSecs())}</span>
            <button class="stt-x" title="Discard the recording" aria-label="Discard the recording" onClick={sttCancel}>✕</button>
          </Show>
          <select
            class="stt-dev"
            value={micSel()}
            disabled={sttPhase() !== "idle"}
            onChange={(e) => chooseMic(e.target.value)}
            title="Microphone - pick the input device when you have several"
            aria-label="Microphone input device"
          >
            <option value="">default mic</option>
            <For each={micDevices()}>{(m) => <option value={m.id}>{m.label}</option>}</For>
          </select>
          <span class="stt-note" classList={{ "stt-note-on": Boolean(sttNote()) }} title={sttNote()}>{sttNote()}</span>
          <button class="send-btn" disabled={props.sending?.()} onClick={() => { props.onSend(); requestAnimationFrame(grow); }}>Send</button>
        </div>
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
        {/* The settings that change what the agent may do stay visible even
            while the options are folded away. */}
        <Show when={props.autoApprove()}>
          <span class="opt-flag opt-flag-warn" title="The agent may run edit, write and bash tools without asking each time. Switch it off under options.">auto-approve</span>
        </Show>
        <Show when={autoSpeak()}>
          <span class="opt-flag" title="Replies are read aloud with the selected voice.">speaking</span>
        </Show>
        <button
          class="opt-toggle"
          classList={{ "opt-toggle-on": optsOpen() }}
          title="Token budget, auto-approve tools and speech"
          aria-expanded={optsOpen()}
          onClick={toggleOpts}
        >options {optsOpen() ? "▴" : "▾"}</button>
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
      {/* Secondary settings fold away so the composer stays compact on a
          small screen. */}
      <Show when={optsOpen()}>
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
          <span class="session-meta" title={`speech: ${ttsAdapter() || "auto"} - ${ttsNote()}`}>voice</span>
          <select
            class="voice-pick"
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
