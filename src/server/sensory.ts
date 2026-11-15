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
import { execFile } from "node:child_process";
import { audit } from "./audit";

export type SensorySidecar = { bin: string | null; asset: string | null; ready: boolean; source: string | null };

export type SensoryConfig = {
  stt?: { bin?: string; model?: string };
  tts?: { bin?: string; voice?: string };
  candidateDirs?: string[];
};

export function readSensoryConfig(): SensoryConfig {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { sensory?: SensoryConfig };
    return cfg.sensory ?? {};
  } catch { return {}; }
}

// Candidate dirs, most specific first: config paths > repo resources >
// home runtime dir. Every path is stated in the doctor so nothing is guessed.
export function candidateDirs(): string[] {
  const cfg = readSensoryConfig();
  return Array.from(new Set([
    ...(cfg.candidateDirs ?? []),
    path.join(process.cwd(), "resources", "sensory"),
    path.join(os.homedir(), ".eventhorizon", "sensory"),
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

export type SensoryStatus = {
  ears: SensorySidecar;
  mouth: SensorySidecar;
  notes: string[];
};

export function sensoryStatus(): SensoryStatus & { tried: { ears: string[]; mouth: string[] } } {
  const cfg = readSensoryConfig();
  const dirs = candidateDirs();

  const earBins = [cfg.stt?.bin, ...dirs.flatMap((d) => ["whisper-cli.exe", "whisper-cli", "whisper-server.exe", "main.exe"].map((f) => path.join(d, f)))];
  const earModels = [cfg.stt?.model, ...dirs.flatMap((d) => ["ggml-base.en.bin", "ggml-small.bin", "ggml-medium.bin"].map((f) => path.join(d, f)))];
  const mouthBins = [cfg.tts?.bin, ...dirs.flatMap((d) => ["piper.exe", "piper"].map((f) => path.join(d, f)))];
  const mouthVoices = [cfg.tts?.voice, ...dirs.flatMap((d) => fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".onnx")).map((f) => path.join(d, f)) : [])];

  const earBin = firstExisting(earBins);
  const earModel = firstExisting(earModels);
  const mouthBin = firstExisting(mouthBins);
  const mouthVoice = firstExisting(mouthVoices);

  const notes: string[] = [];
  const ears: SensorySidecar = { bin: earBin.found, asset: earModel.found, ready: Boolean(earBin.found && earModel.found), source: earBin.found ? "detected" : "absent" };
  const mouth: SensorySidecar = { bin: mouthBin.found, asset: mouthVoice.found, ready: Boolean(mouthBin.found && mouthVoice.found), source: mouthBin.found ? "detected" : "absent" };
  if (!ears.ready) notes.push("ears (STT) not ready - install whisper.cpp and a ggml model; see GET /api/sensory/doctor");
  if (!mouth.ready) notes.push("mouth (TTS) not ready - install piper and a voice; see GET /api/sensory/doctor");
  return { ears, mouth, notes, tried: { ears: Array.from(new Set([...earBin.tried, ...earModel.tried])), mouth: Array.from(new Set([...mouthBin.tried, ...mouthVoice.tried])) } };
}

export function doctor(): { ears: SensorySidecar; mouth: SensorySidecar; tried: { ears: string[]; mouth: string[] }; install: string[] } {
  const s = sensoryStatus();
  return {
    ears: s.ears,
    mouth: s.mouth,
    tried: s.tried,
    install: [
      "ears (STT): build or download whisper.cpp; drop whisper-cli.exe and a ggml-*.bin model (e.g. ggml-base.en.bin) into one of the candidate dirs, or set .harness/config.json sensory.stt.{bin,model}.",
      "mouth (TTS): download piper; drop piper.exe plus a voice (*.onnx + its *.onnx.json) into a candidate dir, or set sensory.tts.{bin,voice}.",
      "House rule: nothing is downloaded automatically - installs are operator-initiated.",
    ],
  };
}

// ---- STT: write the WAV, run the CLI, collect the text ----

export async function transcribe(audioBase64: string, opts?: { language?: string }): Promise<{ ok: boolean; text?: string; error?: string }> {
  const s = sensoryStatus();
  if (!s.ears.ready) return { ok: false, error: "ears (STT) not ready - install whisper.cpp and a ggml model (GET /api/sensory/doctor says exactly what is missing)" };
  const bin = s.ears.bin!;
  const model = s.ears.asset!;
  const dir = path.join(os.homedir(), ".eventhorizon");
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, `stt-${Date.now().toString(36)}.wav`);
  fs.writeFileSync(wav, Buffer.from(audioBase64, "base64"));
  try {
    const args = ["-m", model, "-f", wav, "-nt", "-np"];
    if (opts?.language) args.push("-l", opts.language);
    const text = await new Promise<string>((resolve, reject) => {
      execFile(bin, args, { timeout: 120_000, windowsHide: true, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String((err as Error).message ?? err).slice(0, 300)));
        resolve(String(stdout ?? "") + String(stderr ?? ""));
      });
    });
    const clean = text.split("\n").map((l) => l.replace(/^\[\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, "").trim()).filter((l) => l && !/^\s*$/.test(l)).join(" ").trim();
    audit({ tool: "sensory.stt", note: `${clean.length} chars` });
    return { ok: true, text: clean };
  } catch (e) {
    return { ok: false, error: `whisper failed: ${String((e as Error).message ?? e).slice(0, 200)}` };
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
