// Event Horizon Code - Camera window (sensors S3), a pop-out.
//
// The camera is OFF until Start is pressed here, and only this window is ever
// allowed to open it (the main process scopes the grant to this window). A
// live indicator stays up the whole time; leaving the Camera tab or closing
// the window stops the capture. "Look" sends one frame to a vision model: to
// the engine on this machine by default, and to a BYOK provider only after an
// explicit, loud opt-in that lasts until this window closes and is never saved.

import { createSignal, onCleanup, onMount, For, Show } from "solid-js";
import { apiFetch, apiJson } from "./api";

type Lane = { provider: string; baseUrl: string | null; model: string | null };
type Lanes = { engine: { baseUrl: string } | null; byok: Lane[] };
type Dev = { id: string; label: string };

const DEV_KEY = "ehc.cameraDeviceId";
const MIRROR_KEY = "ehc.cameraMirror";
// A small image or GIF the user picked as the agent's face. Stored only when
// it is small; anything larger lives for this window only.
const FACE_KEY = "ehc.presenceImage";
const FACE_MAX = 1_500_000;
const pretty = (raw: string, i: number): string =>
  raw.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "").replace(/^Default\s*-\s*/i, "Default · ") || `Camera ${i + 1}`;
const stored = (k: string): string => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const store = (k: string, v: string): void => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* storage unavailable */ } };
const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export default function CameraWindow() {
  const [tab, setTab] = createSignal<"camera" | "presence">("camera");
  const [live, setLive] = createSignal(false);
  const [secs, setSecs] = createSignal(0);
  const [devices, setDevices] = createSignal<Dev[]>([]);
  const [devId, setDevId] = createSignal(stored(DEV_KEY));
  const [mirrored, setMirrored] = createSignal(stored(MIRROR_KEY) === "1");
  const [lanes, setLanes] = createSignal<Lanes | null>(null);
  const [lane, setLane] = createSignal<"engine" | "byok">("engine");
  const [provider, setProvider] = createSignal("");
  // The frame-leaves-the-computer switch. Session-only on purpose.
  const [consent, setConsent] = createSignal(false);
  const [question, setQuestion] = createSignal("");
  const [answer, setAnswer] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [note, setNote] = createSignal("");
  const [face, setFace] = createSignal(stored(FACE_KEY));
  let video: HTMLVideoElement | undefined;
  let stream: MediaStream | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let startedAt = 0;
  // Bumped by every start and by cancel: a late stream from a superseded
  // attempt is closed, never shown.
  let startGen = 0;
  const streamLabel = (s: MediaStream): string => (s.getVideoTracks()[0]?.label ?? "").replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, "");

  const flash = (msg: string): void => {
    setNote(msg);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => setNote(""), 9000);
  };
  const stop = (): void => {
    clearInterval(ticker); ticker = undefined;
    clearInterval(poller); poller = undefined;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    setLive(false); setSecs(0);
  };
  // While live, the window asks ~1.5x per second whether the agent wants a
  // frame (camera_look tool), and sends one only in answer to that. Nothing is
  // sent otherwise, and the user sees a note whenever the agent looked.
  const sendFrame = async (): Promise<void> => {
    const image = grabFrame();
    if (!image) return;
    try {
      const r = await apiFetch("/api/sensors/camera/frame", { method: "POST", body: JSON.stringify({ image }) });
      if (r.ok) flash("The agent looked through the camera - answered by the local vision model.");
    } catch { /* the request times out on its own */ }
  };
  const startPolling = (): void => {
    clearInterval(poller);
    poller = setInterval(() => {
      void apiJson<{ request?: boolean }>("/api/sensors/camera/poll", { method: "POST" })
        .then((r) => (r.request ? sendFrame() : undefined))
        .catch(() => undefined);
    }, 700);
  };
  const refreshDevices = async (): Promise<void> => {
    try {
      const list = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "videoinput" && d.deviceId)
        .map((d, i) => ({ id: d.deviceId, label: pretty(d.label, i) }));
      // Reuse the row objects of unchanged devices: rebuilding the options
      // makes Chromium move the selection and fire a change event that is not
      // the user's choice.
      setDevices((prev) => list.map((d) => prev.find((p) => p.id === d.id && p.label === d.label) ?? d));
      if (list.length && devId() && !list.some((d) => d.id === devId())) { store(DEV_KEY, ""); setDevId(""); }
    } catch { /* listed as "default" until the camera has been opened once */ }
  };
  const start = async (): Promise<void> => {
    const base: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
    const open = async (id: string): Promise<MediaStream> => navigator.mediaDevices.getUserMedia({ video: id ? { ...base, deviceId: { exact: id } } : base });
    // "Could not start" rather than "may not": the device exists but no frames come.
    const unusable = (e: unknown): boolean => ["AbortError", "NotReadableError", "TrackStartError", "OverconstrainedError"].includes((e as { name?: string })?.name ?? "");
    // Cancelling bumps the generation; anything the old attempt delivers late
    // is closed instead of shown.
    const gen = ++startGen;
    const stale = (s?: MediaStream): boolean => {
      if (gen === startGen) return false;
      s?.getTracks().forEach((t) => t.stop());
      return true;
    };
    setStarting(true);
    try {
      await refreshDevices();
      if (stale()) return;
      const list = devices();
      let s: MediaStream | undefined;
      const pick = devId();
      if (pick && list.some((d) => d.id === pick)) {
        setNote(`Starting ${list.find((d) => d.id === pick)?.label ?? "the camera"}…`);
        s = await open(pick);
      } else {
        // The OS "default" camera is not always one that works: on the
        // reference machine a VR headset's sensor is the default and never
        // starts. Try it, then the other inputs in turn.
        let last: unknown = new Error("No camera was found");
        for (const id of ["", ...list.map((d) => d.id)]) {
          setNote(id
            ? `The default camera did not start - trying ${list.find((d) => d.id === id)?.label ?? "the next camera"}…`
            : "Starting the default camera… (a device that cannot start takes about 10 seconds to give up)");
          try { s = await open(id); } catch (e) { last = e; if (!unusable(e)) break; continue; }
          if (stale(s)) return;
          if (id) {
            // Remember the one that works, so the next start goes straight to it.
            setDevId(id); store(DEV_KEY, id);
          }
          break;
        }
        if (stale()) return;
        if (!s) throw last;
        if (!pick) flash(`Using ${streamLabel(s) || "a camera"}.`);
      }
      if (stale(s)) return;
      stream = s; startedAt = Date.now();
      if (video) video.srcObject = s;
      setLive(true); setSecs(0); setNote("");
      ticker = setInterval(() => setSecs(Math.floor((Date.now() - startedAt) / 1000)), 500);
      startPolling();
      void refreshDevices();
    } catch (e) {
      if (stale()) return;
      const err = e as { name?: string; message?: string };
      stop();
      flash(err?.name === "NotAllowedError" ? "Camera access was refused - allow cameras for this app in Windows Settings > Privacy & security > Camera"
        : err?.name === "NotFoundError" ? "No camera was found"
        : unusable(e) ? "No camera could be started - check that it is connected and not in use by another app"
        : `Camera unavailable (${err?.name ?? "error"}): ${String(err?.message ?? "").slice(0, 100)}`);
    } finally {
      if (gen === startGen) setStarting(false);
    }
  };
  const cancel = (): void => {
    startGen++;
    stop();
    setStarting(false);
    flash("Cancelled.");
  };
  // Leaving the Camera tab stops the capture: no camera on without its
  // preview and indicator in view.
  const chooseTab = (t: "camera" | "presence"): void => { if (t !== "camera") stop(); setTab(t); };

  const grabFrame = (): string | null => {
    if (!video || !live() || video.videoWidth === 0) return null;
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(video.videoWidth * scale));
    c.height = Math.max(1, Math.round(video.videoHeight * scale));
    c.getContext("2d")?.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.82);
  };

  const look = async (): Promise<void> => {
    const image = grabFrame();
    if (!image) return flash("Start the camera first.");
    const remote = lane() === "byok";
    const p = provider();
    const dest = remote ? (lanes()?.byok.find((x) => x.provider === p) ?? null) : null;
    if (remote && !dest) return flash("Choose a BYOK provider first.");
    setBusy(true); setAnswer(""); setNote("");
    try {
      const r = await apiFetch("/api/sensors/camera/look", {
        method: "POST",
        body: JSON.stringify({ image, question: question(), lane: lane(), provider: remote ? p : undefined, allowRemote: remote ? consent() : undefined }),
      });
      const d = (await r.json()) as { ok: boolean; text?: string; error?: string };
      if (d.ok && d.text) setAnswer(d.text); else flash(d.error ?? "No answer.");
    } catch (e) {
      flash(`Look failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    } finally {
      setBusy(false);
    }
  };

  const pickFace = (file: File | undefined): void => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (!url.startsWith("data:image/")) return flash("That file is not an image.");
      setFace(url);
      // Keep it across runs only when it is small.
      store(FACE_KEY, url.length <= FACE_MAX ? url : "");
      if (url.length > FACE_MAX) flash("Using this image for this session only (it is too large to remember).");
    };
    reader.readAsDataURL(file);
  };

  const remoteOn = () => lane() === "byok" && consent();
  const dest = () => lanes()?.byok.find((x) => x.provider === provider()) ?? null;
  const host = () => { try { return new URL(dest()?.baseUrl ?? "").host; } catch { return dest()?.baseUrl ?? ""; } };
  const engineReady = () => Boolean(lanes()?.engine);

  onMount(() => {
    void refreshDevices();
    void apiJson<Lanes>("/api/sensors/camera/lanes").then(setLanes).catch(() => setLanes({ engine: null, byok: [] }));
  });
  onCleanup(() => { clearTimeout(noteTimer); stop(); });

  return (
    <div class="cam-root">
      <header class="cam-head">
        <strong>Camera</strong>
        <span class="cam-tabs">
          <button class="panel-toggle" classList={{ "panel-toggle-on": tab() === "camera" }} onClick={() => chooseTab("camera")}>Camera</button>
          <button class="panel-toggle" classList={{ "panel-toggle-on": tab() === "presence" }} onClick={() => chooseTab("presence")}>Presence</button>
        </span>
        <Show when={live()}><span class="cam-live" title="The camera is capturing. Stop it, leave this tab, or close this window to end it.">● CAMERA LIVE {clock(secs())}</span></Show>
        <Show when={remoteOn()}><span class="cam-remote" title="Each Look sends a camera frame to your provider.">▲ BYOK VISION ON - frames go to {host()}</span></Show>
      </header>

      <Show when={tab() === "camera"}>
        <div class="cam-stage">
          <video ref={(el) => { video = el; }} autoplay playsinline muted classList={{ "cam-mirror": mirrored() }} />
          <Show when={!live()}><div class="cam-off">Camera is off</div></Show>
        </div>
        <div class="cam-bar">
          <button classList={{ "cam-stop": live() || starting() }} disabled={busy()} onClick={() => (live() ? stop() : starting() ? cancel() : void start())}>
            {starting() ? "Cancel" : live() ? "Stop camera" : "Start camera"}
          </button>
          <select class="cam-dev" value={devId()} disabled={live() || starting()} onChange={(e) => { if (document.activeElement === e.currentTarget) { setDevId(e.target.value); store(DEV_KEY, e.target.value); } }} title="Camera - pick the input device when you have several" aria-label="Camera input device">
            <option value="">default camera</option>
            <For each={devices()}>{(d) => <option value={d.id}>{d.label}</option>}</For>
          </select>
          <label class="ehc-auto" title="Mirror the preview, as a front camera usually is.">
            <input type="checkbox" checked={mirrored()} onChange={(e) => { setMirrored(e.target.checked); store(MIRROR_KEY, e.target.checked ? "1" : ""); }} />
            mirror
          </label>
        </div>

        <div class="cam-eyes">
          <div class="cam-lane">
            <span class="session-meta">vision</span>
            <select class="cam-dev" value={lane()} onChange={(e) => setLane(e.target.value === "byok" ? "byok" : "engine")}>
              <option value="engine" disabled={!engineReady()}>on this machine (engine){engineReady() ? "" : " - not running"}</option>
              <option value="byok" disabled={(lanes()?.byok.length ?? 0) === 0}>BYOK Vision{lanes() && lanes()!.byok.length === 0 ? " - no provider saved" : ""}</option>
            </select>
            <Show when={lane() === "byok"}>
              <select class="cam-dev" value={provider()} onChange={(e) => { setProvider(e.target.value); setConsent(false); }} title="Where a frame would be sent">
                <option value="">choose a provider</option>
                <For each={lanes()?.byok ?? []}>{(p) => <option value={p.provider}>{p.provider}{p.model ? ` - ${p.model}` : ""}</option>}</For>
              </select>
            </Show>
          </div>
          <div class="cam-lane">
            <input class="cam-q" type="text" value={question()} placeholder="Ask about this frame... (empty: describe it)" onKeyDown={(e) => { if (e.key === "Enter" && !busy() && live()) void look(); }} />
            <button class="cam-look" disabled={busy() || !live() || (lane() === "byok" && !consent())} onClick={() => void look()}>
              {busy() ? "Looking…" : lane() === "byok" ? `Send frame to ${host()} and ask` : "Look"}
            </button>
          </div>
          <Show when={answer()}><p class="cam-answer">{answer()}</p></Show>
        </div>

        <Show when={lane() === "byok"}>
          <div class="cam-consent" classList={{ "cam-consent-on": consent() }}>
            <strong>Frames will leave this computer.</strong>
            <Show when={dest()} fallback={<p>Choose a provider to see where frames would go.</p>}>
              <p>Each Look sends one camera frame, with your question, to <b>{dest()!.provider}</b> at <code>{dest()!.baseUrl}</code>. It is sent only when you press the button while BYOK Vision is on, and nothing is stored here.</p>
            </Show>
            <label class="ehc-auto cam-consent-box">
              <input type="checkbox" checked={consent()} disabled={!dest()} onChange={(e) => setConsent(e.target.checked)} />
              Allow BYOK Vision until this window closes
            </label>
          </div>
        </Show>
      </Show>

      <Show when={tab() === "presence"}>
        <div class="cam-presence">
          <Show when={face()} fallback={
            <svg class="face" viewBox="0 0 200 200" role="img" aria-label="Agent">
              <circle cx="100" cy="100" r="92" class="face-head" />
              <ellipse cx="68" cy="88" rx="11" ry="15" class="face-eye" />
              <ellipse cx="132" cy="88" rx="11" ry="15" class="face-eye" />
              <path d="M66 132 Q100 152 134 132" class="face-mouth" />
            </svg>
          }>
            <img class="face-img" src={face()} alt="Agent presence" />
          </Show>
        </div>
        <div class="cam-bar">
          <label class="ehc-auto" title="An image or GIF to show as the agent's face.">
            face file
            <input type="file" accept="image/*" onChange={(e) => pickFace(e.target.files?.[0])} />
          </label>
          <Show when={face()}><button onClick={() => { setFace(""); store(FACE_KEY, ""); }}>Use the built-in face</button></Show>
        </div>
        <p class="session-meta">A simple presence for now. A generated or inference-driven virtual agent (video, voice) plugs in here later - see docs/SENSORS.md.</p>
      </Show>

      <p class="stt-note" classList={{ "stt-note-on": Boolean(note()) }} title={note()}>{note()}</p>
    </div>
  );
}
