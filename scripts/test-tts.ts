// TTS adapter tests: platform-aware default, availability notes, honest
// refusals, and voice listing. Run: npm run tts:test
//
// The Web Speech (system) adapter lives in the renderer, so this suite covers
// the server side: engine (llama-tts + TTS GGUF) and piper, plus the plan the
// renderer consumes.

import path from "node:path";
import { ttsAvailability, listVoices, speak, detectEngineTts, voicesDir, ttsDoctor } from "../src/server/tts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log(`[ehc] tts adapter tests (platform: ${process.platform})`);

  // 1. platform-aware default: Windows speaks through OS voices, others engine
  const avail = ttsAvailability();
  const isWindows = process.platform === "win32";
  check("availability lists all four adapters", avail.adapters.map((a) => a.adapter).join(",") === "engine,system,piper,byok");
  check("system adapter is always available (renderer voices)", avail.adapters.find((a) => a.adapter === "system")?.ok === true);
  check("platform is reported", avail.platform === process.platform);
  if (isWindows) {
    check("Windows prefers system voices", avail.preferred === "system", avail.preferred);
    check("defaultMode names Web Speech", /Web Speech/.test(avail.defaultMode), avail.defaultMode);
  } else {
    check("non-Windows prefers the engine adapter", avail.preferred === "engine", avail.preferred);
    check("defaultMode names Pocket TTS", /Pocket TTS/.test(avail.defaultMode), avail.defaultMode);
  }

  // 2. availability notes state exactly what is missing (never a silent false)
  for (const a of avail.adapters) {
    if (!a.ok) check(`${a.adapter} absence is explained`, a.note.length > 10, a.note);
  }

  // 3. engine detection reports what it tried (doctor-style honesty)
  const eng = detectEngineTts();
  check("engine detection reports tried paths", eng.tried.length > 0, `${eng.tried.length} paths`);
  check("llama-tts presence is a plain fact", typeof eng.bin === "string" || eng.bin === null);
  console.log(`    llama-tts: ${eng.bin ? path.basename(eng.bin) : "(not found)"}; tts model: ${eng.model ? path.basename(eng.model) : "(none)"}`);

  // 4. voices: always at least the system entry; references are listed when present
  const v = listVoices();
  check("voice list includes a system voice", v.voices.some((x) => x.adapter === "system"));
  check("voice list reports the preferred adapter", typeof v.preferred === "string" && v.preferred.length > 0, v.preferred);
  check("voices dir is stated", voicesDir().length > 0);
  const refs = v.voices.filter((x) => x.kind === "reference");
  check("reference voices carry a path note", refs.every((r) => Boolean(r.note)));
  console.log(`    voices: ${v.voices.length} (${refs.length} reference recording(s))`);

  // 5. speaking: the system adapter must NOT pretend to synthesize server-side
  const sys = await speak("hello", { adapter: "system" });
  check("system adapter refuses server-side synthesis with guidance", sys.ok === false && /renderer/.test(sys.error ?? ""), sys.error ?? "");

  // 6. empty text is refused before any adapter runs
  const empty = await speak("   ", { adapter: "engine" });
  check("empty text refused", empty.ok === false && /text required/.test(empty.error ?? ""), empty.error ?? "");

  // 7. engine/piper refusal paths name the missing piece
  if (!eng.bin || !eng.model) {
    const e = await speak("hello world", { adapter: "engine" });
    check("engine without a model refuses with the reason", e.ok === false && Boolean(e.error), e.error ?? "");
  }
  const piper = avail.adapters.find((a) => a.adapter === "piper");
  if (!piper?.ok) {
    const p = await speak("hello", { adapter: "piper" });
    check("piper absent refuses with the reason", p.ok === false && Boolean(p.error), p.error ?? "");
  }

  // 8. doctor: an install ladder with no auto-download, platform-appropriate
  const doc = ttsDoctor();
  check("doctor reports the platform default", doc.preferred === avail.preferred, doc.preferred);
  check("doctor lists the adapters", doc.adapters.length === 4);
  check("doctor gives per-adapter install guidance", doc.install.length >= 3);
  check("doctor never promises an automatic download", !doc.install.some((l) => /downloading|will download|auto-?download/i.test(l)));
  check("doctor names the voices dir", doc.voicesDir === voicesDir());
  if (isWindows) check("doctor says system voices need nothing", doc.install.some((l) => /nothing to install/i.test(l)));
  else check("doctor mentions a TTS GGUF", doc.install.some((l) => /GGUF/i.test(l)));

  console.log(failures === 0 ? "[ehc] tts tests: ALL PASS" : `[ehc] tts tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] tts tests crashed:", e); process.exit(1); });
