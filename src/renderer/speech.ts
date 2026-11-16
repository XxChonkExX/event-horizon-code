// Event Horizon Code - Renderer speech (Web Speech API)
//
// The Windows path: the OS voices are already there (Microsoft voices, the
// classic SAM family among them), so speech needs no model, no download and no
// server round trip. Linux/mac/ARM use the engine's Pocket TTS adapter instead
// (see src/server/tts.ts); this module always exposes the system voices and can
// also PLAY wav audio returned by the server adapters.

import { apiJson } from "./api";

export type SpeechVoice = { id: string; name: string; lang: string; local: boolean };

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function listSystemVoices(): SpeechVoice[] {
  if (!speechSupported()) return [];
  return window.speechSynthesis.getVoices().map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: v.localService }));
}

// Chromium populates the voice list asynchronously - getVoices() returns [] until
// it does, and the reliable signal is the "voiceschanged" event (polling alone can
// miss it). Wait for both, with a generous ceiling: an empty list is a valid
// outcome that the UI must handle rather than a hang.
export function whenVoicesReady(timeoutMs = 6000): Promise<SpeechVoice[]> {
  return new Promise((resolve) => {
    if (!speechSupported()) return resolve([]);
    const have = listSystemVoices();
    if (have.length) return resolve(have);
    const synth = window.speechSynthesis;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(iv);
      clearTimeout(to);
      synth.onvoiceschanged = null;
      resolve(listSystemVoices());
    };
    const iv = setInterval(() => { if (listSystemVoices().length) finish(); }, 200);
    const to = setTimeout(finish, timeoutMs);
    synth.onvoiceschanged = () => { if (listSystemVoices().length) finish(); };
    // Touching the list once more nudges some builds to populate it.
    void synth.getVoices();
  });
}

/** Force a re-read (used by the picker's refresh button). */
export function refreshSystemVoices(): SpeechVoice[] {
  if (!speechSupported()) return [];
  return listSystemVoices();
}

// Default voice preference: an English Microsoft voice first (Windows' SAPI
// set), then any local English voice, then the platform default.
export function pickDefaultVoice(voices: SpeechVoice[]): SpeechVoice | null {
  if (!voices.length) return null;
  const score = (v: SpeechVoice): number => {
    let s = 0;
    if (/^en/i.test(v.lang)) s += 10;
    if (/microsoft/i.test(v.name)) s += 6;
    if (/david|mark|zira|sam/i.test(v.name)) s += 4;
    if (v.local) s += 2;
    return s;
  };
  return [...voices].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export function speakSystem(text: string, opts?: { voiceURI?: string; rate?: number; pitch?: number }): { ok: boolean; error?: string } {
  if (!speechSupported()) return { ok: false, error: "Web Speech API unavailable in this runtime" };
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
  if (opts?.voiceURI) {
    const v = synth.getVoices().find((x) => x.voiceURI === opts.voiceURI);
    if (v) u.voice = v;
  }
  u.rate = opts?.rate ?? 1;
  u.pitch = opts?.pitch ?? 1;
  synth.speak(u);
  return { ok: true };
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}

// ---- server-side adapters (engine Pocket TTS / piper) ----

export async function speakViaServer(text: string, opts?: { voice?: string; adapter?: string }): Promise<{ ok: boolean; error?: string; adapter?: string; voice?: string }> {
  const { apiFetch } = await import("./api");
  const res = await apiFetch("/api/tts/speak", { method: "POST", body: JSON.stringify({ text, voice: opts?.voice, adapter: opts?.adapter }) });
  const d = (await res.json()) as { ok: boolean; audio?: string; error?: string; adapter?: string; voice?: string };
  if (!d.ok || !d.audio) return { ok: false, error: d.error ?? "synthesis failed", adapter: d.adapter };
  await playAudio(d.audio);
  return { ok: true, adapter: d.adapter, voice: d.voice };
}

let currentAudio: HTMLAudioElement | null = null;
export function playAudio(dataUrl: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      currentAudio?.pause();
      const a = new Audio(dataUrl);
      currentAudio = a;
      a.onended = () => resolve();
      a.onerror = () => resolve();
      void a.play().catch(() => resolve());
    } catch { resolve(); }
  });
}

export function stopAudio(): void {
  try { currentAudio?.pause(); } catch { /* ignore */ }
  currentAudio = null;
}

// ---- combined: what this machine can actually do ----

export type TtsPlan = { adapter: string; platform: string; note: string };

export async function ttsPlan(): Promise<TtsPlan> {
  try {
    const d = await apiJson<{ preferred: string; platform: string; defaultMode: string }>("/api/tts/voices");
    return { adapter: d.preferred, platform: d.platform, note: d.defaultMode };
  } catch {
    return { adapter: speechSupported() ? "system" : "none", platform: "unknown", note: "server unreachable" };
  }
}
