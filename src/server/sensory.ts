// Event Horizon Code - Sensory sidecars (S2): ears (STT) and mouth (TTS)
//
// House rules: no model or binary is shipped or downloaded without the user
// asking. This module therefore DETECTS what is present (config paths first,
// then well-known candidate dirs), exposes real endpoints that work when the
// sidecars exist, and refuses plainly - with a doctor that says exactly what
// to install and where to drop it - when they do not.
//
//   ears  - whisper.cpp  : whisper-cli/whisper-server + a ggml-*.bin model
//   mouth - piper        : piper(.exe) + a .onnx voice with its .onnx.json
//
// STT input: 16 kHz mono WAV (the renderer records it directly).
// TTS output: 16 kHz mono WAV from piper, returned as a data URL for playback.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { audit } from "./audit";

export type SensorySidecar = { bin: string | null; asset: string | null; ready: boolean; source: string | null };

export type SensoryConfig = {
  stt?: { bin?: string; model?: string; language?: string };
  tts?: { bin?: string; voice?: string };
  candidateDirs?: string[];
};

export function readSensoryConfig(): SensoryConfig {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { sensory?: SensoryConfig };
    return cfg.sensory ?? {};
  } catch { return {}; }
}

// Where the optional downloads (sensoryfetch.ts) and manual installs live.
export function sensoryDir(): string {
  return path.join(os.homedir(), ".eventhorizon", "sensory");
}

// Candidate dirs, most specific first: config paths > repo resources >
// home runtime dir. Every path is stated in the doctor so nothing is guessed.
export function candidateDirs(): string[] {
  const cfg = readSensoryConfig();
  return Array.from(new Set([
    ...(cfg.candidateDirs ?? []),
    path.join(process.cwd(), "resources", "sensory"),
    sensoryDir(),
  ]));
}

function firstExisting(paths: Array<string | undefined>): { found: string | null; tried: string[] } {
  const tried: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    tried.push(p);
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return { found: p, tried }; } catch { /* next */ }
  }
  return { found: null, tried };
}

// ---- discovery ----
// Unambiguous program names only. The old whisper.cpp binary was called
// "main", which on PATH could be anything - that name is accepted in the
// candidate dirs but never on PATH.
const EAR_BINS = ["whisper-cli.exe", "whisper-cli", "whisper-server.exe", "whisper-server", "main.exe", "main"];
const EAR_PATH_BINS = process.platform === "win32" ? ["whisper-cli.exe", "whisper-server.exe"] : ["whisper-cli", "whisper-server"];

/** A program on PATH - an install done with a package manager (brew, pacman, apt). */
function onPath(names: string[]): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of names) {
      if (!dir) continue;
      try {
        const p = path.join(dir, name);
        if (fs.statSync(p).isFile()) return p;
      } catch { /* next */ }
    }
  }
  return null;
}

// Bigger is better when several models are installed. The user's explicit
// choice - config, or the request's `model` - always wins over this order.
const MODEL_RANK: Array<[RegExp, number]> = [
  [/large-v3-turbo/, 80], [/large-v3/, 70], [/large-v2/, 65], [/large-v1/, 60],
  [/medium/, 50], [/small/, 40], [/base/, 30], [/tiny/, 20],
];
export function modelRank(name: string): number {
  return MODEL_RANK.find(([re]) => re.test(name))?.[1] ?? 10;
}

/** Every model reachable: the configured path plus any ggml-*.bin in the candidate dirs. */
function discoverModels(cfg: SensoryConfig, dirs: string[]): string[] {
  const found = new Set<string>();
  const configured = cfg.stt?.model;
  if (configured) {
    try { if (fs.statSync(configured).isFile()) found.add(path.resolve(configured)); } catch { /* stated as missing below */ }
  }
  for (const d of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const f of names) {
      if (!/^ggml-.+\.bin$/.test(f)) continue;
      const p = path.join(d, f);
      try { if (fs.statSync(p).isFile()) found.add(p); } catch { /* vanished */ }
    }
  }
  return [...found];
}

export function sttLanguage(): string {
  return (readSensoryConfig().stt?.language ?? "").toLowerCase();
}

/**
 * The model a request should use. With `model`, it must name an installed one
 * (by file name - never an arbitrary path) or the result is null. Without it,
 * the best installed model wins; for English the English-only variant is
 * preferred over its multilingual twin.
 */
export function pickModel(models: string[], opts?: { language?: string; model?: string }): string | null {
  if (opts?.model) return models.find((m) => path.basename(m) === path.basename(opts.model!)) ?? null;
  const en = (opts?.language ?? sttLanguage()).toLowerCase().startsWith("en");
  const score = (m: string) => modelRank(path.basename(m)) * 2 + (en && /\.en\.bin$/.test(m) ? 1 : 0);
  return [...models].sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0] ?? null;
}

export type SensoryStatus = {
  ears: SensorySidecar;
  mouth: SensorySidecar;
  notes: string[];
  /** Installed ggml models, best first. */
  models: string[];
};

export function sensoryStatus(): SensoryStatus & { tried: { ears: string[]; mouth: string[] } } {
  const cfg = readSensoryConfig();
  const dirs = candidateDirs();

  const earBin = firstExisting([cfg.stt?.bin, ...dirs.flatMap((d) => EAR_BINS.map((f) => path.join(d, f))), onPath(EAR_PATH_BINS) ?? undefined]);
  const models = discoverModels(cfg, dirs);
  const model = pickModel(models);
  const mouthBins = [cfg.tts?.bin, ...dirs.flatMap((d) => ["piper.exe", "piper"].map((f) => path.join(d, f)))];
  const mouthVoices = [cfg.tts?.voice, ...dirs.flatMap((d) => fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".onnx")).map((f) => path.join(d, f)) : [])];

  const mouthBin = firstExisting(mouthBins);
  const mouthVoice = firstExisting(mouthVoices);

  const notes: string[] = [];
  const ears: SensorySidecar = { bin: earBin.found, asset: model, ready: Boolean(earBin.found && model), source: earBin.found ? "detected" : "absent" };
  const mouth: SensorySidecar = { bin: mouthBin.found, asset: mouthVoice.found, ready: Boolean(mouthBin.found && mouthVoice.found), source: mouthBin.found ? "detected" : "absent" };
  if (!ears.ready) notes.push("ears (STT) not ready - install whisper.cpp and a ggml model; see GET /api/sensory/doctor");
  if (!mouth.ready) notes.push("mouth (TTS) not ready - install piper and a voice; see GET /api/sensory/doctor");
  // With nothing found, still name the places that were looked in.
  const modelPaths = models.length ? models : dirs.flatMap((d) => ["ggml-base.en.bin", "ggml-small.en.bin"].map((f) => path.join(d, f)));
  return { ears, mouth, notes, models, tried: { ears: Array.from(new Set([...earBin.tried, ...modelPaths])), mouth: Array.from(new Set([...mouthBin.tried, ...mouthVoice.tried])) } };
}

export function doctor(): { ears: SensorySidecar; mouth: SensorySidecar; tried: { ears: string[]; mouth: string[] }; install: string[]; models: string[] } {
  const s = sensoryStatus();
  return {
    ears: s.ears,
    mouth: s.mouth,
    tried: s.tried,
    models: s.models,
    install: [
      `ears (STT): needs whisper-cli and a ggml-*.bin model. Either click the optional downloads in the Sensory panel (GitHub / Hugging Face, checksum-verified; only when you ask), or install whisper.cpp yourself and drop whisper-cli(.exe) plus a model into ${sensoryDir()} or resources/sensory/, or point .harness/config.json sensory.stt.{bin,model} at them. Found models: ${s.models.map((m) => m.split(path.sep).pop()).join(", ") || "none"}.`,
      "mouth (TTS): download piper; drop piper.exe plus a voice (*.onnx + its *.onnx.json) into a candidate dir, or set sensory.tts.{bin,voice}.",
      "House rule: nothing is fetched on its own - every install is a click by you.",
    ],
  };
}
// ---- STT: write the WAV, run the CLI, collect the text ----
const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // about 8 minutes of 16 kHz mono

// ---- whisper-server: spawn once, keep warm, POST audio to /inference ----
// (operator decision 2026-11-26: implement the HTTP path instead of running a
// server binary with CLI flags, which just timed out on every transcription)
let srvProc: ChildProcess | null = null;
let srvPort = 0;
let srvModel = "";
let srvExitHook = false;

async function ensureWhisperServer(bin: string, model: string): Promise<number> {
  if (srvProc && srvModel === model && srvPort) return srvPort;
  await stopWhisperServer();
  srvPort = 8178 + Math.floor(Math.random() * 500);
  srvModel = model;
  srvProc = spawn(bin, ["-m", model, "--port", String(srvPort), "-t", "4"], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  srvProc.on("error", () => { try { srvProc?.kill(); } catch { /* gone */ } srvProc = null; });
  if (!srvExitHook) {
    srvExitHook = true;
    process.once("exit", () => { try { srvProc?.kill(); } catch { /* gone */ } });
  }
  // Readiness: ANY http answer (even 404) means the socket is up - the model
  // load happens before the listener binds, so poll up to 120 s.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (!srvProc || srvProc.exitCode !== null) break; // died while loading
    try { await fetch(`http://127.0.0.1:${srvPort}/`, { signal: AbortSignal.timeout(1000) }); return srvPort; }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const died = !srvProc || srvProc.exitCode !== null;
  srvProc = null; srvPort = 0; srvModel = "";
  throw new Error(died ? "whisper-server exited while starting - the model may not load on this machine" : "whisper-server did not become ready within 120 s");
}

export async function stopWhisperServer(): Promise<void> {
  try { srvProc?.kill(); } catch { /* gone */ }
  srvProc = null; srvPort = 0; srvModel = "";
}

/** POST one WAV to a running whisper-server's /inference (multipart). Extracted for tests. */
export async function transcribeViaServer(port: number, wav: Buffer, language: string): Promise<string> {
  const boundary = `----ehc${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const parts: Buffer[] = [];
  const field = (name: string, value: string): void => {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  };
  field("temperature", "0");
  field("response_format", "json");
  if (language) field("language", language);
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(wav);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const res = await fetch(`http://127.0.0.1:${port}/inference`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`whisper-server answered ${res.status}`);
  const j = JSON.parse(await res.text()) as { text?: string };
  return cleanTranscript(j.text ?? "");
}

/**
 * whisper-cli prints the transcript on stdout and nothing else when run with
 * -np; its progress log goes to stderr and is deliberately NOT part of the
 * transcript. Timestamps are stripped, lines are joined.
 */
export function cleanTranscript(stdout: string): string {
  return stdout.split(/\r?\n/)
    .map((l) => l.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

export async function transcribe(audioBase64: string, opts?: { language?: string; model?: string }): Promise<{ ok: boolean; text?: string; error?: string }> {
  const s = sensoryStatus();
  const model = pickModel(s.models, opts);
  if (!s.ears.ready) return { ok: false, error: "ears (STT) not ready - install whisper.cpp and a ggml model (GET /api/sensory/doctor says exactly what is missing; the Sensory panel has optional downloads)" };
  if (!model) return { ok: false, error: `unknown model "${String(opts?.model ?? "").slice(0, 60)}" - pick one of the installed models` };
  const bin = s.ears.bin!;
  const isServer = /whisper-server/i.test(path.basename(bin));
  let audio: Buffer;
  try { audio = Buffer.from(audioBase64, "base64"); } catch { return { ok: false, error: "audio must be base64" }; }
  if (audio.length < 44 || audio.toString("latin1", 0, 4) !== "RIFF") return { ok: false, error: "audio must be a WAV (16 kHz mono)" };
  if (audio.length > MAX_AUDIO_BYTES) return { ok: false, error: "the recording is too long (over about 8 minutes)" };
  const language = (opts?.language ?? sttLanguage()).toLowerCase();
  // whisper-server is an HTTP sidecar, not a CLI: spawn once with the model,
  // keep it warm, POST every recording (operator decision 2026-11-26).
  if (isServer) {
    try {
      const port = await ensureWhisperServer(bin, model);
      const clean = await transcribeViaServer(port, audio, language && !/\.en\.bin$/.test(model) ? language : "");
      audit({ tool: "sensory.stt", note: `${clean.length} chars, ${Math.round(audio.length / 32000)} s, ${path.basename(model)} (server)` });
      return { ok: true, text: clean };
    } catch (e) {
      return { ok: false, error: `whisper-server failed: ${String((e as Error).message ?? e).slice(0, 240)}` };
    }
  }
  const wav = path.join(os.tmpdir(), `ehc-stt-${process.pid}-${Date.now().toString(36)}.wav`);
  fs.writeFileSync(wav, audio, { mode: 0o600 });
  try {
    const args = ["-m", model, "-f", wav, "-nt", "-np"];
    // An English-only model has no language to pick; whisper refuses -l there.
    if (language && !/\.en\.bin$/.test(model)) args.push("-l", language);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(bin, args, { timeout: 120_000, windowsHide: true, maxBuffer: 1_000_000 }, (err, out, stderr) => {
        if (err) {
          const tail = String(stderr ?? "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
          return reject(new Error((err.killed ? "whisper timed out after 120 s" : `whisper exited with code ${err.code ?? "?"}${tail ? ` - ${tail}` : ""}`).slice(0, 240)));
        }
        resolve(String(out ?? ""));
      });
    });
    const clean = cleanTranscript(stdout);
    audit({ tool: "sensory.stt", note: `${clean.length} chars, ${Math.round(audio.length / 32000)} s, ${path.basename(model)}` });
    return { ok: true, text: clean };
  } catch (e) {
    return { ok: false, error: `whisper failed: ${String((e as Error).message ?? e).slice(0, 240)}` };
  } finally {
    try { fs.rmSync(wav, { force: true }); } catch { /* best effort */ }
  }
}
// ---- TTS: pipe text to piper, return the WAV as a data URL ----

export async function speak(text: string): Promise<{ ok: boolean; audio?: string; error?: string }> {
  const s = sensoryStatus();
  if (!s.mouth.ready) return { ok: false, error: "mouth (TTS) not ready - install piper and a voice (GET /api/sensory/doctor says exactly what is missing)" };
  const bin = s.mouth.bin!;
  const voice = s.mouth.asset!;
  const dir = path.join(os.homedir(), ".eventhorizon");
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, `tts-${Date.now().toString(36)}.wav`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(bin, ["-m", voice, "--output_file", wav], { timeout: 120_000, windowsHide: true }, (err) => {
        if (err) reject(new Error(String((err as Error).message ?? err).slice(0, 300)));
        else resolve();
      });
      child.stdin?.end(text);
    });
    if (!fs.existsSync(wav)) return { ok: false, error: "piper produced no audio" };
    const b64 = fs.readFileSync(wav).toString("base64");
    audit({ tool: "sensory.tts", note: `${text.length} chars -> ${Math.round(b64.length / 1024)} KB` });
    return { ok: true, audio: `data:image/wav;base64,${b64}`.replace("image/wav", "audio/wav") };
  } catch (e) {
    return { ok: false, error: `piper failed: ${String((e as Error).message ?? e).slice(0, 200)}` };
  } finally {
    try { fs.rmSync(wav, { force: true }); } catch { /* best effort */ }
  }
}
