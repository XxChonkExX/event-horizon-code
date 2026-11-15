// Sensory sidecar tests: honest absence. With no whisper/piper installed
// (the default - nothing is bundled or auto-downloaded), the endpoints and the
// doctor must state exactly what is missing and where to install it.
// Run: npm run sensory:test

import { sensoryStatus, doctor, transcribe, speak } from "../src/server/sensory";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log("[ehc] sensory sidecar tests");

  const s = sensoryStatus();
  check("status reports ears presence as a fact", typeof s.ears.ready === "boolean" && typeof s.ears.bin === "object");
  check("status reports mouth presence as a fact", typeof s.mouth.ready === "boolean");
  check("status lists tried candidate paths", s.tried.ears.length > 0 && s.tried.mouth.length > 0, JSON.stringify(s.tried.ears.slice(0, 2)));
  if (!s.ears.ready) check("absent ears produce a guidance note", s.notes.some((n) => n.includes("ears")));
  if (!s.mouth.ready) check("absent mouth produces a guidance note", s.notes.some((n) => n.includes("mouth")));

  const d = doctor();
  check("doctor gives install guidance", d.install.length >= 2 && d.install.some((i) => i.includes("whisper")) && d.install.some((i) => i.includes("piper")));
  check("doctor does not download anything", !d.install.some((i) => /downloading|fetch now|auto-install/i.test(i)));

  if (!s.ears.ready) {
    const t = await transcribe("UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=");
    check("transcribe refuses plainly when ears are absent", t.ok === false && /not ready/.test(t.error ?? ""), t.error ?? "");
  } else {
    console.log("  (skip: ears installed - live STT test not covered here)");
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
