// Event Horizon Code - Sensory panel
// Eyes (vision), ears (speech-to-text via whisper.cpp), mouth (TTS via piper).
// States what is present and what is missing.
//
// Downloads on this panel are OPTIONAL and start only from a click: pinned
// official sources, checksum-verified, cancellable. Nothing is fetched on its
// own, no request of any kind is made until the user clicks, and the app
// works fully offline without any of it.

import { createSignal, onCleanup, onMount, For, Show } from "solid-js";
import { apiFetch, apiJson, openExternal } from "./api";

type Sidecar = { bin: string | null; asset: string | null; ready: boolean; source: string | null };
type Status = { ears: Sidecar; mouth: Sidecar; notes: string[]; models: string[] };
type Item = { id: string; kind: "engine" | "model"; label: string; note: string; file: string; url: string; size: number; sha256: string; langs?: string; installed: boolean; applies: boolean };
type Phase = "connecting" | "downloading" | "verifying" | "installing" | "done" | "error" | "cancelled";
type Job = { id: string; label: string; phase: Phase; bytes: number; total: number; error?: string };
type Catalog = { dir: string; items: Item[]; links: { whisperRelease: string; whisperModels: string; piperRelease: string }; job: Job | null };

// The languages whisper.cpp understands, in its own two-letter codes.
const LANGS = "en=English,zh=Chinese,de=German,es=Spanish,ru=Russian,ko=Korean,fr=French,ja=Japanese,pt=Portuguese,tr=Turkish,pl=Polish,ca=Catalan,nl=Dutch,ar=Arabic,sv=Swedish,it=Italian,id=Indonesian,hi=Hindi,fi=Finnish,vi=Vietnamese,he=Hebrew,uk=Ukrainian,el=Greek,ms=Malay,cs=Czech,ro=Romanian,da=Danish,hu=Hungarian,ta=Tamil,no=Norwegian,th=Thai,ur=Urdu,hr=Croatian,bg=Bulgarian,lt=Lithuanian,la=Latin,mi=Maori,ml=Malayalam,cy=Welsh,sk=Slovak,te=Telugu,fa=Persian,lv=Latvian,bn=Bengali,sr=Serbian,az=Azerbaijani,sl=Slovenian,kn=Kannada,et=Estonian,mk=Macedonian,br=Breton,eu=Basque,is=Icelandic,hy=Armenian,ne=Nepali,mn=Mongolian,bs=Bosnian,kk=Kazakh,sq=Albanian,sw=Swahili,gl=Galician,mr=Marathi,pa=Punjabi,si=Sinhala,km=Khmer,sh=Serbo-Croatian,yi=Yiddish,lo=Lao,uz=Uzbek,fo=Faroese,ht=Haitian Creole,ps=Pashto,tk=Turkmen,nn=Nynorsk,mt=Maltese,sa=Sanskrit,lb=Luxembourgish,my=Burmese,bo=Tibetan,tl=Tagalog,mg=Malagasy,as=Assamese,tt=Tatar,haw=Hawaiian,ln=Lingala,ha=Hausa,ba=Bashkir,jw=Javanese,su=Sundanese";
const LANG_LIST = LANGS.split(",").map((p) => { const [code, name] = p.split("="); return { code, name }; });

const TERMINAL: Phase[] = ["done", "error", "cancelled"];
const base = (p: string | null | undefined): string => (p ?? "").split(/[\\/]/).pop() ?? "";
const mb = (n: number): string => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1048576))} MB`);
const toast = (text: string): void => { window.dispatchEvent(new CustomEvent("ehc-toast", { detail: { text, kind: "info" } })); };

export default function SensoryPanel() {
  const [status, setStatus] = createSignal<Status | null>(null);
  const [catalog, setCatalog] = createSignal<Catalog | null>(null);
  const [job, setJob] = createSignal<Job | null>(null);
  const [note, setNote] = createSignal("");
  // Speech preferences are kept like the mic and TTS voice picks: on this
  // machine, in the renderer's storage, sent with each transcription.
  const [lang, setLang] = createSignal(localStorage.getItem("ehc.sttLanguage") ?? "");
  const [pick, setPick] = createSignal(localStorage.getItem("ehc.sttModel") ?? "");
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopPolling = (): void => { clearInterval(timer); timer = undefined; };
  const refresh = async (): Promise<void> => {
    try {
      const [s, c] = await Promise.all([apiJson<Status>("/api/sensory/status"), apiJson<Catalog>("/api/sensory/catalog")]);
      setStatus(s);
      setCatalog(c);
      if (c.job) setJob(c.job);
      setNote("");
    } catch { setNote("Server not running."); }
  };
  // Progress is polled on loopback while a download runs; polling stops as
  // soon as the job ends.
  const watch = (): void => {
    stopPolling();
    timer = setInterval(async () => {
      try {
        const j = (await apiJson<{ job: Job | null }>("/api/sensory/fetch/status")).job;
        setJob(j);
        if (!j || TERMINAL.includes(j.phase)) {
          stopPolling();
          if (j?.phase === "done") toast(`${j.label} installed`);
          await refresh();
        }
      } catch { /* server briefly unavailable - keep watching */ }
    }, 500);
  };
  const start = async (id: string): Promise<void> => {
    try {
      const res = await apiFetch("/api/sensory/fetch", { method: "POST", body: JSON.stringify({ id }) });
      const d = (await res.json()) as { ok: boolean; error?: string; job?: Job };
      if (!res.ok || !d.ok || !d.job) { setNote(d.error ?? "the download did not start"); return; }
      setJob(d.job);
      setNote("");
      watch();
    } catch (e) { setNote(`Could not start the download: ${String((e as Error)?.message ?? e)}`); }
  };
  const cancel = async (): Promise<void> => {
    try { await apiJson("/api/sensory/fetch", { method: "DELETE" }); } catch { /* the next poll shows the truth */ }
  };
  const link = async (url: string | undefined): Promise<void> => {
    if (!url) return;
    const r = await openExternal(url);
    if (!r.ok) setNote(`Could not open the link: ${r.error ?? ""}`);
  };
  const chooseLang = (code: string): void => { setLang(code); try { localStorage.setItem("ehc.sttLanguage", code); } catch { /* storage unavailable */ } };
  const chooseModel = (file: string): void => { setPick(file); try { localStorage.setItem("ehc.sttModel", file); } catch { /* storage unavailable */ } };

  // Re-check whenever this panel is asked for (the composer's speech-setup
  // path, which may arrive while the panel is already showing) and whenever
  // the window regains focus - files may have been added or removed by hand.
  const onWantPanel = (ev: Event): void => { if ((ev as CustomEvent<{ id?: string }>).detail?.id === "sensory") void refresh(); };
  onMount(() => {
    void refresh().then(() => { if (job() && !TERMINAL.includes(job()!.phase)) watch(); });
    window.addEventListener("ehc:want-panel", onWantPanel);
    window.addEventListener("focus", refresh);
  });
  onCleanup(() => {
    stopPolling();
    window.removeEventListener("ehc:want-panel", onWantPanel);
    window.removeEventListener("focus", refresh);
  });

  const items = () => catalog()?.items ?? [];
  const models = () => items().filter((i) => i.kind === "model");
  const engines = () => items().filter((i) => i.kind === "engine" && i.applies);
  const installed = () => (status()?.models ?? []).map(base);
  const extra = () => installed().filter((f) => !models().some((m) => m.file === f) && f !== pick());
  // The model a transcription will use: the user's pick when it is installed,
  // otherwise the server's choice.
  const using = () => (pick() && installed().includes(pick()!) ? pick() : base(status()?.ears.asset)) ?? "";
  const engineReady = () => Boolean(status()?.ears.bin);
  const busy = () => Boolean(job() && !TERMINAL.includes(job()!.phase));
  const pct = () => (job() && job()!.total ? Math.min(100, Math.round((job()!.bytes / job()!.total) * 100)) : 0);
  const english = () => lang() === "" || lang().startsWith("en");

  return (
    <div class="sensory-panel">
      <h3>Speech-to-text</h3>
      <div class="sense-head">
        <span class={status()?.ears.ready ? "doctor-ok" : "doctor-warn"}>
          {status()?.ears.ready ? "Ready" : "Not set up yet"}
        </span>
        <Show when={status()?.ears.ready}>
          <span class="session-meta" title={status()?.ears.bin ?? undefined}>engine {base(status()?.ears.bin)} - model {using()}</span>
        </Show>
      </div>
      <div class="sense-row">
        <span class="session-meta">spoken language</span>
        <select class="sense-select" value={lang()} onChange={(e) => chooseLang(e.target.value)} title="Tells the model which language it will hear. Detect automatically is slower on multilingual models.">
          <option value="">detect automatically</option>
          <For each={LANG_LIST}>{(l) => <option value={l.code}>{l.name}</option>}</For>
        </select>
      </div>
      <div class="sense-sub">
        Language models - optional, from huggingface.co (ggerganov/whisper.cpp).{" "}
        {english() ? "The English-only models are faster and more accurate for English." : "Choose a multilingual model for this language."}
      </div>
      <ul class="cat-list">
        <For each={models()}>{(it) => (
          <li class="cat-row">
            <div class="cat-main">
              <strong>{it.label}</strong> <span class="cat-size">{mb(it.size)}</span>
              <Show when={it.installed && it.file === using()}><span class="cat-badge">in use</span></Show>
              <Show when={it.installed && it.file !== using()}>
                <button class="cat-btn" title="Use this model for speech-to-text" onClick={() => chooseModel(it.file)}>use</button>
              </Show>
              <div class="cat-note">{it.note}</div>
            </div>
            <Show when={!it.installed}>
              <button
                class="cat-btn"
                disabled={busy() || !engineReady()}
                title={engineReady() ? `Download ${mb(it.size)} from ${it.url.split("/")[2]} - only if you click` : "Install the whisper.cpp engine below first"}
                onClick={() => void start(it.id)}
              >download</button>
            </Show>
          </li>
        )}</For>
        <For each={extra()}>{(f) => (
          <li class="cat-row">
            <div class="cat-main"><strong>{f}</strong><div class="cat-note">Installed by hand - detected in the sensory folder.</div></div>
            <button class="cat-btn" onClick={() => chooseModel(f)}>use</button>
          </li>
        )}</For>
      </ul>

      <div class="sense-sub">
        Engine - whisper.cpp, from github.com (ggml-org/whisper.cpp). Installs into <code>{catalog()?.dir}</code>.
      </div>
      <ul class="cat-list">
        <For each={engines()}>{(it) => (
          <li class="cat-row">
            <div class="cat-main">
              <strong>{it.label}</strong> <span class="cat-size">{mb(it.size)}</span>
              <Show when={it.installed}><span class="cat-badge">installed</span></Show>
              <div class="cat-note">{it.note}</div>
            </div>
            <Show when={!it.installed}>
              <button class="cat-btn" disabled={busy()} title={`Download ${mb(it.size)} from github.com - only if you click`} onClick={() => void start(it.id)}>download</button>
            </Show>
          </li>
        )}</For>
        <Show when={catalog() && engines().length === 0}>
          <li class="cat-row">
            <div class="cat-main">
              <strong>whisper.cpp on this system</strong>
              <div class="cat-note">Install it with your package manager (Homebrew: brew install whisper-cpp; Arch: pacman -S whisper.cpp) or build it - Event Horizon finds whisper-cli on your PATH and models in the sensory folder.</div>
            </div>
          </li>
        </Show>
      </ul>
      <div class="checks">
        <button class="cat-btn" title="Opens in your own browser" onClick={() => void link(catalog()?.links.whisperRelease)}>whisper.cpp releases</button>
        <button class="cat-btn" title="Opens in your own browser" onClick={() => void link(catalog()?.links.whisperModels)}>models on Hugging Face</button>
      </div>

      <Show when={busy()}>
        <div class="fetch-box">
          <div class="fetch-line">
            <span>{job()!.label}</span>
            <span>{job()!.phase}{job()!.phase === "downloading" ? ` - ${mb(job()!.bytes)} of ${mb(job()!.total)}` : ""}</span>
          </div>
          <div class="fetch-bar"><i style={{ width: `${pct()}%` }} /></div>
          <button class="cat-btn" onClick={() => void cancel()}>cancel</button>
        </div>
      </Show>
      <Show when={job()?.phase === "error"}><p class="doctor-warn">The last download failed and nothing was installed: {job()!.error}</p></Show>
      <Show when={note()}><p class="doctor-warn">{note()}</p></Show>

      <h3>Text-to-speech</h3>
      <p>
        <span class={status()?.mouth.ready ? "doctor-ok" : ""}>
          {status()?.mouth.ready ? `piper is ready (${base(status()?.mouth.asset)})` : "Replies use the system or engine voice; the optional piper voice is not installed."}
        </span>
      </p>
      <div class="checks">
        <button class="cat-btn" title="Opens in your own browser" onClick={() => void link(catalog()?.links.piperRelease)}>piper releases</button>
      </div>

      <h3>Vision</h3>
      <p>Vision runs through the engine's own multimodal lane - load a vision model and its mmproj file in the Models panel. Nothing to download here.</p>

      <p class="sense-policy">
        Optional and offline-friendly: nothing on this page downloads unless you click it, every file is checked against its published SHA-256, and no request of any kind is made before that click.
        <button class="cat-btn" onClick={() => void refresh()}>re-check</button>
      </p>
    </div>
  );
}
