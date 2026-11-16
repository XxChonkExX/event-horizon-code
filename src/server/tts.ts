// Event Horizon Code - Text to speech, adapter-based
//
// One interface, swappable backends, and a platform-aware default:
//
//   Windows        -> "system": the OS voices through the renderer's Web Speech
//                     API (Microsoft voices; the classic SAM-family default).
//                     Instant, no model, nothing to install.
//   Linux/mac/ARM  -> "engine": llama-tts from the bundled chonkllama build
//                     driving Pocket TTS (tiny, ~100M, CC BY 4.0) or Qwen3-TTS
//                     (1.7B, multilingual). Zero new runtime, works headless.
//   both           -> "piper" (rhasspy/piper sidecar) and "byok" (own cloud key)
//                     remain selectable; voices can be swapped in every adapter.
//
// Engine voices are speaker reference recordings: drop a wav/mp3 into the voices
// dir and it appears as a selectable voice (voice cloning).
//
// Nothing is downloaded automatically (house rule): absent backends refuse with
// exactly what is missing, and GET /api/tts/voices lists what IS available.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { audit } from "./audit";
import { resolveEngineBinary, readEngineConfig } from "./engine";
import { candidateDirs, readSensoryConfig } from "./sensory";

export type TtsAdapterId = "engine" | "piper" | "system" | "byok";

export type TtsVoice = {
  id: string;
  name: string;
  adapter: TtsAdapterId;
  /** "model" built-in voice, "reference" cloned from a recording, "system" OS voice. */
  kind: "model" | "reference" | "system";
  note?: string;
};

export type TtsAvailability = { adapter: TtsAdapterId; ok: boolean; note: string };

export type TtsConfig = {
  adapter?: TtsAdapterId | "auto";
  voicesDir?: string;
  speakerFile?: string;
  engineModel?: string;
  engineMmproj?: string;
  language?: string;
  voices?: Record<string, { adapter?: TtsAdapterId; reference?: string; lang?: string }>;
};

export function readTtsConfig(): TtsConfig {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { tts?: TtsConfig; sensory?: { tts?: TtsConfig } };
    return cfg.tts ?? cfg.sensory?.tts ?? {};
  } catch { return {}; }
}

// Where speaker reference recordings live; each file becomes a selectable voice.
export function voicesDir(): string {
  const cfg = readTtsConfig();
  return cfg.voicesDir && fs.existsSync(cfg.voicesDir)
    ? cfg.voicesDir
    : path.join(os.homedir(), ".eventhorizon", "voices");
}

function listReferenceVoices(): TtsVoice[] {
  const dir = voicesDir();
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(wav|mp3|flac|ogg)$/i.test(f))
      .map((f) => ({ id: `ref:${f}`, name: f.replace(/\.[^.]+$/, ""), adapter: "engine" as const, kind: "reference" as const, note: path.join(dir, f) }));
  } catch { return []; }
}

// ---- adapter: engine (llama-tts + a TTS GGUF) ----

type EngineTts = { bin: string | null; model: string | null; mmproj: string | null };

export function detectEngineTts(): EngineTts & { tried: string[] } {
  const cfg = readTtsConfig();
  const bin = resolveEngineBinary();
  const exe = process.platform === "win32" ? "llama-tts.exe" : "llama-tts";
  const candidates: string[] = [];
  if (bin.path) candidates.push(path.join(path.dirname(bin.path), exe));
  candidates.push(path.join(process.cwd(), "resources", "engine", exe));
  const tried = [...candidates];
  let binPath: string | null = null;
  for (const c of candidates) { try { if (fs.existsSync(c)) { binPath = c; break; } } catch { /* next */ } }

  // TTS model: explicit config, else any *.gguf whose name says tts in the
  // candidate dirs (models dirs included, since users drop models there).
  const dirs = Array.from(new Set([...candidateDirs(), ...readEngineConfig().ggufDirs, path.join(os.homedir(), ".eventhorizon", "models")]));
  let model = cfg.engineModel && fs.existsSync(cfg.engineModel) ? cfg.engineModel : null;
  let mmproj = cfg.engineMmproj && fs.existsSync(cfg.engineMmproj) ? cfg.engineMmproj : null;
  if (!model) {
    for (const d of dirs) {
      let files: string[] = [];
      try { files = fs.readdirSync(d); } catch { continue; }
      for (const f of files) {
        const full = path.join(d, f);
        tried.push(full);
        if (!/\.gguf$/i.test(f)) continue;
        if (/mmproj/i.test(f) && /tts|pocket/i.test(f)) { if (!mmproj) mmproj = full; continue; }
        if (/tts/i.test(f) && !model) model = full;
      }
    }
  }
  return { bin: binPath, model, mmproj, tried };
}

// ---- availability + voices ----

export function ttsAvailability(): { adapters: TtsAvailability[]; preferred: TtsAdapterId; platform: string; defaultMode: string } {
  const cfg = readTtsConfig();
  const eng = detectEngineTts();
  const sensory = readSensoryConfig();
  const piperBin = sensory.tts?.bin && fs.existsSync(sensory.tts.bin) ? sensory.tts.bin : null;
  const piperVoice = sensory.tts?.voice && fs.existsSync(sensory.tts.voice) ? sensory.tts.voice : null;

  const adapters: TtsAvailability[] = [
    {
      adapter: "engine",
      ok: Boolean(eng.bin && eng.model),
      note: eng.bin && eng.model
        ? `llama-tts + ${path.basename(eng.model)}`
        : eng.bin
          ? "llama-tts found; no TTS GGUF yet - add one (e.g. ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF or Pocket TTS) to ~/.eventhorizon/models"
          : "llama-tts.exe not found next to the engine binary",
    },
    { adapter: "system", ok: true, note: "OS voices via the renderer (Web Speech API) - always available" },
    {
      adapter: "piper",
      ok: Boolean(piperBin && piperVoice),
      note: piperBin && piperVoice ? `${path.basename(piperBin)} + ${path.basename(piperVoice)}` : "piper not installed (see /api/sensory/doctor)",
    },
    { adapter: "byok", ok: false, note: "bring your own key (not configured)" },
  ];
  const configured = cfg.adapter && cfg.adapter !== "auto" ? (cfg.adapter as TtsAdapterId) : null;
  // Platform default: Windows speaks through the OS voices (instant, no model);
  // everywhere else the bundled engine with Pocket TTS is the primary path.
  const isWindows = process.platform === "win32";
  const byDriver = isWindows ? ["system", "engine", "piper"] : ["engine", "piper", "system"];
  const preferred = configured ?? (byDriver.find((id) => adapters.find((a) => a.adapter === id)?.ok) as TtsAdapterId | undefined) ?? "system";
  return { adapters, preferred, platform: process.platform, defaultMode: isWindows ? "system (Web Speech / OS voices)" : "engine (llama-tts + Pocket TTS)" };
}

export function listVoices(): { preferred: TtsAdapterId; platform: string; defaultMode: string; voices: TtsVoice[]; availability: TtsAvailability[] } {
  const { adapters, preferred, platform, defaultMode } = ttsAvailability();
  const eng = detectEngineTts();
  const voices: TtsVoice[] = [];
  if (eng.model) {
    voices.push({ id: "model:default", name: `${path.basename(eng.model).replace(/\.gguf$/i, "")} (built-in)`, adapter: "engine", kind: "model", note: "no reference recording" });
  }
  voices.push(...listReferenceVoices());
  const sensory = readSensoryConfig();
  if (sensory.tts?.voice) {
    voices.push({ id: `piper:${path.basename(sensory.tts.voice)}`, name: path.basename(sensory.tts.voice).replace(/\.onnx$/i, ""), adapter: "piper", kind: "model", note: sensory.tts.voice });
  }
  voices.push({ id: "system:default", name: "System default voice", adapter: "system", kind: "system", note: "rendered by the OS (the renderer enumerates the real list)" });
  return { preferred, platform, defaultMode, voices, availability: adapters };
}

// ---- synthesize ----

export type SpeakResult = { ok: boolean; audio?: string; adapter?: TtsAdapterId; voice?: string; error?: string };

export async function speak(text: string, opts?: { voice?: string; adapter?: TtsAdapterId }): Promise<SpeakResult> {
  const clean = (text ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!clean) return { ok: false, error: "text required" };
  const { adapters, preferred } = ttsAvailability();
  const wanted = opts?.adapter ?? preferred;

  // "system" is played by the renderer (Web Speech API) - the server cannot
  // capture OS audio, so it says so rather than pretending.
  if (wanted === "system") {
    return { ok: false, adapter: "system", error: "the system adapter plays in the renderer - use speechSynthesis there (no server audio)" };
  }

  if (wanted === "engine") {
    const av = adapters.find((a) => a.adapter === "engine");
    if (!av?.ok) return { ok: false, adapter: "engine", error: av?.note ?? "engine TTS not available" };
    const eng = detectEngineTts();
    return speakWithEngine(clean, eng, opts?.voice);
  }
  if (wanted === "piper") {
    const av = adapters.find((a) => a.adapter === "piper");
    if (!av?.ok) return { ok: false, adapter: "piper", error: av?.note ?? "piper not available" };
    const sensory = readSensoryConfig();
    return speakWithPiper(clean, sensory.tts!.bin!, sensory.tts!.voice!);
  }
  return { ok: false, error: `adapter "${wanted}" is not configured` };
}

async function speakWithEngine(text: string, eng: EngineTts, voiceId?: string): Promise<SpeakResult> {
  const cfg = readTtsConfig();
  const dir = path.join(os.homedir(), ".eventhorizon");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `tts-${Date.now().toString(36)}.wav`);

  // Voice selection: "ref:<file>" or a configured voice entry -> speaker file.
  let speaker = cfg.speakerFile && fs.existsSync(cfg.speakerFile) ? cfg.speakerFile : null;
  if (voiceId?.startsWith("ref:")) {
    const candidate = path.join(voicesDir(), voiceId.slice(4));
    if (fs.existsSync(candidate)) speaker = candidate;
  } else if (voiceId && cfg.voices?.[voiceId]?.reference && fs.existsSync(cfg.voices[voiceId].reference!)) {
    speaker = cfg.voices[voiceId].reference!;
  }

  const args = [
    "-m", eng.model!,
    ...(eng.mmproj ? ["-mm", eng.mmproj] : []),
    "-p", text,
    "--output", out,
    "-ngl", "99",
    "--tts-lang", cfg.language ?? "en",
    ...(speaker ? ["--tts-speaker-file", speaker] : []),
  ];
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(eng.bin!, args, { timeout: 120_000, windowsHide: true, maxBuffer: 1_000_000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(String(stderr || (err as Error).message).slice(0, 300)));
        else resolve();
      });
    });
    if (!fs.existsSync(out)) return { ok: false, adapter: "engine", error: "llama-tts produced no audio file" };
    const b64 = fs.readFileSync(out).toString("base64");
    audit({ tool: "tts.speak", note: `engine ${text.length} chars -> ${Math.round(b64.length / 1024)} KB${speaker ? ` voice=${path.basename(speaker)}` : ""}` });
    return { ok: true, adapter: "engine", voice: speaker ? path.basename(speaker) : "model:default", audio: `data:audio/wav;base64,${b64}` };
  } catch (e) {
    return { ok: false, adapter: "engine", error: `llama-tts failed: ${String((e as Error).message ?? e).slice(0, 200)}` };
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* best effort */ }
  }
}

async function speakWithPiper(text: string, bin: string, voice: string): Promise<SpeakResult> {
  const dir = path.join(os.homedir(), ".eventhorizon");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `tts-${Date.now().toString(36)}.wav`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(bin, ["-m", voice, "--output_file", out], { timeout: 120_000, windowsHide: true }, (err) => {
        if (err) reject(new Error(String((err as Error).message).slice(0, 300)));
        else resolve();
      });
      child.stdin?.end(text);
    });
    if (!fs.existsSync(out)) return { ok: false, adapter: "piper", error: "piper produced no audio" };
    const b64 = fs.readFileSync(out).toString("base64");
    audit({ tool: "tts.speak", note: `piper ${text.length} chars -> ${Math.round(b64.length / 1024)} KB` });
    return { ok: true, adapter: "piper", voice: path.basename(voice), audio: `data:audio/wav;base64,${b64}` };
  } catch (e) {
    return { ok: false, adapter: "piper", error: `piper failed: ${String((e as Error).message ?? e).slice(0, 200)}` };
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* best effort */ }
  }
}
