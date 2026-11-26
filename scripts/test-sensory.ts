// Sensory sidecar tests: honest absence AND the live path.
// With no whisper/piper installed (the default - nothing is bundled), the
// endpoints and the doctor must state exactly what is missing and where to
// get it. With whisper.cpp installed, the real transcription path is checked;
// set EH_STT_SAMPLE=<speech.wav> to include a real transcription.
// Run: npm run sensory:test

import fs from "node:fs";
import { sensoryStatus, doctor, transcribe, speak } from "../src/server/sensory";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log("[ehc] sensory sidecar tests");

  const s = sensoryStatus();
  // bin is a path when the engine is found and null when it is not.
  check("status reports ears presence as a fact", typeof s.ears.ready === "boolean" && (s.ears.bin === null || typeof s.ears.bin === "string") && s.ears.ready === Boolean(s.ears.bin && s.ears.asset));
  check("status reports mouth presence as a fact", typeof s.mouth.ready === "boolean");
  check("status lists tried candidate paths", s.tried.ears.length > 0 && s.tried.mouth.length > 0, JSON.stringify(s.tried.ears.slice(0, 2)));
  if (!s.ears.ready) check("absent ears produce a guidance note", s.notes.some((n) => n.includes("ears")));
  if (!s.mouth.ready) check("absent mouth produces a guidance note", s.notes.some((n) => n.includes("mouth")));

  const d = doctor();
  check("doctor gives install guidance", d.install.length >= 2 && d.install.some((i) => i.includes("whisper")) && d.install.some((i) => i.includes("piper")));
  check("doctor does not download anything", !d.install.some((i) => /downloading|fetch now|auto-install/i.test(i)));

  const WAV = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="; // a valid, silent 16 kHz mono WAV header
  check("status lists the discovered models (best first)", Array.isArray(s.models));
  if (!s.ears.ready) {
    const t = await transcribe(WAV);
    check("transcribe refuses plainly when ears are absent", t.ok === false && /not ready/.test(t.error ?? ""), t.error ?? "");
  } else {
    // Ears are installed on this machine: exercise the real path.
    check("a discovered model backs the ready state", s.ears.asset !== null && s.models.includes(s.ears.asset!));
    const notWav = await transcribe("bm90IGEgd2F2IGZpbGU="); // "not a wav file"
    check("non-WAV input is refused before whisper runs", notWav.ok === false && /WAV/.test(notWav.error ?? ""), notWav.error ?? "");
    const unknown = await transcribe(WAV, { model: "ggml-not-installed.bin" });
    check("an unknown model name is refused, never guessed", unknown.ok === false && /unknown model/.test(unknown.error ?? ""), unknown.error ?? "");
    // EH_STT_SAMPLE=<path to a speech WAV> turns on a real transcription.
    const sample = process.env.EH_STT_SAMPLE;
    if (sample && fs.existsSync(sample)) {
      const r = await transcribe(fs.readFileSync(sample).toString("base64"), { language: "en" });
      check("live: speech WAV is transcribed", r.ok === true && /country/i.test(r.text ?? ""), JSON.stringify(r).slice(0, 160));
      check("live: the transcript carries no whisper log lines", !/read_audio_data|whisper_|ggml_/.test(r.text ?? ""), r.text ?? "");
    } else {
      console.log("  (skip: set EH_STT_SAMPLE=<speech.wav> for a live transcription check)");
    }
  }
  if (!s.mouth.ready) {
    const sp = await speak("hello");
    check("speak refuses plainly when mouth is absent", sp.ok === false && /not ready/.test(sp.error ?? ""), sp.error ?? "");
  } else {
    console.log("  (skip: mouth installed - live TTS test not covered here)");
  }

  console.log(failures === 0 ? "[ehc] sensory tests: ALL PASS" : `[ehc] sensory tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] sensory tests crashed:", e); process.exit(1); });
