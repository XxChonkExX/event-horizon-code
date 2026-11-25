// Real-keychain proof for the BYOK secrets module: bundle src/server/secrets.ts
// and run it INSIDE Electron, where safeStorage reaches the OS keychain
// (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux).
// Proves: encrypt -> ciphertext on disk (never plaintext) -> decrypt roundtrip,
// tamper refusal, encrypt-in-place, status privacy. Run: npm run secrets:test:electron
//
// Four Electron processes, two profiles:
//   seal       checks above; leaves a freshly sealed key in the temp secrets file.
//   open       a FRESH process decrypts what the previous one sealed. One process
//              alone never proves the property the feature rests on: the wrapping
//              key outlives the process that created it.
//   crash-seal a BRAND-NEW profile: one save, then an abrupt process.exit - no
//              clean shutdown, nothing flushed on the way out.
//   crash-open the same new profile, later: the save made in crash-seal must
//              still decrypt. (On Windows a fresh profile writes its wrapping
//              key ~10 s after launch; sealing waits for it, so the save is
//              durable the moment it returns.)
//
// Uses a throwaway key and temp files - never the operator's real ones.
// Needs a desktop session (a keyring); CI runners skip this leg.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repo = process.cwd();
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-secrets-electron-"));
// Shared across launches like the real app's profile and files are: the
// secrets files and the userData directories that hold the key-wrapping
// material.
for (const d of ["user-data", "user-data-crash", "sec", "sec-crash"]) fs.mkdirSync(path.join(work, d));
const KEY = "sk-throwaway-" + crypto.randomBytes(12).toString("hex");

const esbuild = require("esbuild");
esbuild.buildSync({
  entryPoints: [path.join(repo, "src", "server", "secrets.ts")],
  outfile: path.join(work, "bundle.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["electron"],
  logLevel: "silent",
});

// The Electron main script: real app lifecycle, assertions, result file, exit.
// (Plain string concatenation only - this is a template literal on the outside.)
fs.writeFileSync(path.join(work, "main.cjs"), `
const { app, safeStorage } = require("electron");
app.disableHardwareAcceleration();
const fs = require("node:fs");
const path = require("node:path");
const shared = process.env.EH_SEC_SHARED;
const phase = process.env.EH_SEC_PHASE;
const crash = phase.indexOf("crash-") === 0;
const resultFile = process.env.EH_SEC_RESULT;
// The same userData for the launches that share a profile, as in the real app.
app.setPath("userData", path.join(shared, crash ? "user-data-crash" : "user-data"));
app.whenReady().then(async () => {
  const out = { phase, pid: process.pid, platform: process.platform, checks: [], fail: 0 };
  const check = (name, cond, detail) => {
    out.checks.push({ name, ok: Boolean(cond), detail: detail ? String(detail).slice(0, 300) : "" });
    if (!cond) out.fail++;
  };
  const abruptExit = (code) => { fs.writeFileSync(resultFile, JSON.stringify(out)); app.exit(code); };
  try {
    const file = path.join(shared, crash ? "sec-crash" : "sec", "secrets.json");
    process.env.EH_SECRETS_FILE = file;
    const s = require("./bundle.cjs");
    const KEY = process.env.EH_SEC_KEY;
    const BASE = "https://api.example.com/v1";

    check("keychain is reachable in Electron main", s.encryptionAvailable() === true, "safeStorage reports unavailable");
    if (s.encryptionAvailable() && phase === "crash-seal") {
      if (process.platform === "win32") check("fresh profile: the wrapping key is NOT on disk before the first save", s.wrappingKeyOnDisk() === false, JSON.stringify(s.wrappingKeyOnDisk()));
      const t0 = Date.now();
      const w = await s.writeSecret("openai", { baseUrl: BASE, apiKey: KEY });
      const waited = Date.now() - t0;
      out.waitedMs = waited;
      check("save on a fresh profile reports the key as durable", w.ok === true && w.encrypted === true && w.settled === true, JSON.stringify(w) + " after " + waited + " ms");
      if (process.platform === "win32") {
        check("...because the save WAITED for the wrapping key to reach disk (~10 s on a new profile)", waited > 3000 && s.wrappingKeyOnDisk() === true, "waited " + waited + " ms, onDisk=" + JSON.stringify(s.wrappingKeyOnDisk()));
      }
      // Leave exactly the way a crash leaves: no clean shutdown, no flush.
      abruptExit(0);
      return;
    }
    if (s.encryptionAvailable() && phase === "seal") {
      const w = await s.writeSecret("openai", { baseUrl: BASE, apiKey: KEY });
      check("write reports encrypted storage", w.ok === true && w.encrypted === true && w.settled === true, JSON.stringify(w));
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const blob = raw.openai.apiKey;
      check("disk holds an enc1: ciphertext, never the key", typeof blob === "string" && blob.startsWith("enc1:") && !blob.includes("sk-throwaway"));
      check("baseUrl stays readable on disk", raw.openai.baseUrl === BASE);
      // Independent confirmation through Electron's own API (not our module).
      const direct = safeStorage.decryptString(Buffer.from(blob.slice(5), "base64"));
      check("Electron safeStorage decrypts the stored blob to the key", direct === KEY);
      const r = s.readSecret("openai");
      check("module decrypt roundtrip", r && r.apiKey === KEY && r.baseUrl === BASE);
      // Two encryptions of the same key: DPAPI/Keychain produce a fresh nonce
      // per seal; the Linux v11 libsecret backend is DETERMINISTIC (verified
      // live on GNOME/Wayland - see docs/ENCRYPTION.md). Assert the seal
      // everywhere; assert ciphertext difference only on randomizing
      // platforms.
      const second = await s.writeSecret("anthropic", { apiKey: KEY });
      const blob2 = JSON.parse(fs.readFileSync(file, "utf8")).anthropic.apiKey;
      const randomizedSeal = process.platform !== "linux";
      check("each seal decrypts (and differs where the backend randomizes)",
        second.ok && Boolean(blob2) && (randomizedSeal ? blob2 !== blob : true),
        JSON.stringify({ ok: second.ok === true, randomizedSeal, sameCiphertext: blob2 === blob }));
      // Tamper -> refused, never a garbage key.
      const tampered = blob.slice(0, -6) + "//////";
      check("tamper actually changed the blob", tampered !== blob);
      fs.writeFileSync(file, JSON.stringify({ openai: { baseUrl: "https://a", apiKey: tampered } }));
      let code = "";
      let why = "";
      try { s.readSecret("openai"); } catch (e) { code = e.code || e.message; why = e.message || ""; }
      check("tampered blob is refused as undecryptable", code === "undecryptable", code);
      // The agent loop keeps only the first 240 characters of a model error.
      check("the undecryptable reason survives the loop's 240-char cap", why.length > 0 && why.length <= 240, "len " + why.length);
      // Encrypt-in-place: plaintext values sealed, already-sealed left alone, non-secrets untouched.
      const keep = blob2;
      fs.writeFileSync(file, JSON.stringify({ a: { apiKey: "plain-a", baseUrl: "https://a" }, b: { apiKey: keep, note: "x" } }));
      const e = await s.encryptAllSecrets();
      const after = JSON.parse(fs.readFileSync(file, "utf8"));
      check("encryptAll seals plaintext values", e.ok === true && e.encrypted === 1 && e.already === 1 && e.settled === true, JSON.stringify(e));
      check("already-sealed value left byte-identical", after.b.apiKey === keep);
      check("non-secret fields untouched by encryptAll", after.a.baseUrl === "https://a" && after.b.note === "x");
      check("sealed value still decrypts after encryptAll", s.readSecret("a").apiKey === "plain-a");
      // A per-provider model round-trips and never gets sealed.
      const wm = await s.writeSecret("a", { model: "gpt-4o-mini" });
      check("per-provider model is stored and read back in the clear", wm.ok === true && s.readSecret("a").model === "gpt-4o-mini" && after.a.baseUrl === "https://a", JSON.stringify(wm));
      // Backups: an exact plaintext copy of the file, listed by name only.
      const bk = s.createBackup();
      const diskNow = fs.readFileSync(file, "utf8");
      check("backup is a byte-identical copy of the file", bk.ok === true && fs.readFileSync(bk.path, "utf8") === diskNow, JSON.stringify(bk.ok ? { bytes: bk.bytes } : bk));
      const listed = s.listBackups();
      check("backup listing carries names, never values", listed.length === 1 && !JSON.stringify(listed).includes("enc1:") && !JSON.stringify(listed).includes("gpt-4o-mini"), JSON.stringify(listed));
      check("backup can be deleted by its listed name", s.deleteBackup(listed[0].name).ok === true && s.listBackups().length === 0);
      // Status privacy + state.
      const st = s.secretsStatus();
      const stj = JSON.stringify(st);
      check("status carries no key material", !stj.includes("plain-a") && !stj.includes("sk-throwaway") && !stj.includes("enc1:"));
      check("status reports the os-keychain storage mode", st.storage === "os-keychain" && st.encryptionAvailable === true);
      check("status marks sealed providers decryptable", st.providers.length === 2 && st.providers.every((p) => p.encrypted && p.decryptable === true));
      check("status shows the stored model", st.providers.find((p) => p.provider === "a").model === "gpt-4o-mini");
      // Only FULLY usable providers are offered to the picker: b has a key but
      // no base URL in this fixture, so it must not be offered.
      check("only fully usable providers are offered to the picker", s.usableByokProviders().map((p) => p.provider).join(",") === "a", JSON.stringify(s.usableByokProviders()));
      check("headless note absent when the keychain is present", st.headlessNote === null);
      // Deletion removes exactly one provider.
      check("delete removes one provider", s.deleteSecret("a").ok === true && s.readSecret("a") === null && s.readSecret("b") !== null);
      check("no temp files left behind", fs.readdirSync(path.dirname(file)).every((f) => f === "secrets.json"), fs.readdirSync(path.dirname(file)).join(","));
      // Handoff: one fresh seal of the key, left on disk for the next launch.
      fs.writeFileSync(file, "{}");
      const h = await s.writeSecret("openai", { baseUrl: BASE, apiKey: KEY });
      const left = JSON.parse(fs.readFileSync(file, "utf8"));
      check("a sealed key is left on disk for the next launch", h.ok === true && h.encrypted === true && left.openai.apiKey.startsWith("enc1:") && !JSON.stringify(left).includes("sk-throwaway"));
      out.blob = left.openai.apiKey;
    } else if (s.encryptionAvailable() && phase === "open") {
      const sealPid = Number(process.env.EH_SEC_SEAL_PID);
      check("a different process than the one that sealed", Number.isFinite(sealPid) && sealPid !== process.pid, sealPid + " vs " + process.pid);
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      check("the file holds the ciphertext the previous launch wrote", Boolean(raw.openai) && raw.openai.apiKey === process.env.EH_SEC_BLOB);
      check("nothing on disk is plaintext", !JSON.stringify(raw).includes("sk-throwaway"));
      const r = s.readSecret("openai");
      check("key sealed by the PREVIOUS process decrypts in this one", Boolean(r) && r.apiKey === KEY && r.baseUrl === BASE, r ? "baseUrl mismatch" : "null");
      const row = s.secretsStatus().providers.find((p) => p.provider === "openai");
      check("status reports the stored key decryptable", Boolean(row) && row.encrypted === true && row.decryptable === true, JSON.stringify(row));
      const re = await s.writeSecret("openai", { baseUrl: BASE, apiKey: KEY });
      // Chromium's v11 libsecret backend on Linux encrypts DETERMINISTICALLY:
      // same plaintext -> byte-identical ciphertext (verified live on
      // GNOME/Wayland, Strix box: encryptString(x) === encryptString(x), both
      // decrypt). DPAPI (Windows) and the macOS Keychain randomize. Assert
      // decryptability everywhere; assert the ciphertext CHANGED only on
      // platforms whose backend randomizes. Equality of ciphertext leaks
      // equality of plaintext (documented in docs/ENCRYPTION.md) - it never
      // leaks the key itself.
      const reBlob = JSON.parse(fs.readFileSync(file, "utf8")).openai.apiKey;
      const reRead = s.readSecret("openai");
      const randomized = process.platform !== "linux";
      check("re-saving decrypts (and differs where the backend randomizes)",
        re.ok === true && Boolean(reRead) && reRead.apiKey === KEY && (randomized ? reBlob !== process.env.EH_SEC_BLOB : true),
        JSON.stringify({ ok: re.ok === true, randomized, sameCiphertext: reBlob === process.env.EH_SEC_BLOB, decrypts: reRead ? reRead.apiKey === KEY : false }));
    } else if (s.encryptionAvailable() && phase === "crash-open") {
      const sealPid = Number(process.env.EH_SEC_CRASH_PID);
      check("a different process than the one that crashed", Number.isFinite(sealPid) && sealPid !== process.pid, sealPid + " vs " + process.pid);
      const r = s.readSecret("openai");
      check("the key saved moments before an ABRUPT exit on a brand-new profile still decrypts", Boolean(r) && r.apiKey === KEY, r ? "wrong key" : "null / undecryptable");
      const row = s.secretsStatus().providers.find((p) => p.provider === "openai");
      check("and is reported decryptable", Boolean(row) && row.decryptable === true, JSON.stringify(row));
    }
  } catch (err) {
    out.crash = String((err && err.stack) || err);
    out.fail++;
  }
  fs.writeFileSync(resultFile, JSON.stringify(out));
  // Let Chromium settle its on-disk state before leaving: the next launch has
  // to find it. (The crash-seal phase deliberately does NOT get here.)
  await new Promise((resolve) => setTimeout(resolve, 1500));
  app.quit();
});
`);

const electronExe = path.join(repo, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
async function runPhase(phase, extraEnv) {
  const resultFile = path.join(work, `result-${phase}.json`);
  // Remove the run-as-node switch entirely: an EMPTY value still switches
  // Electron into plain-node mode (found by probe), where require("electron")
  // is a path string and there is no safeStorage.
  const env = { ...process.env, EH_SEC_RESULT: resultFile, EH_SEC_SHARED: work, EH_SEC_PHASE: phase, EH_SEC_KEY: KEY, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronExe, [path.join(work, "main.cjs")], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const code = await new Promise((resolve) => {
    // The first save on a fresh profile legitimately waits ~10 s for the
    // profile's wrapping key; keep a wide margin beyond that.
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(-1); }, 120_000);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
  });
  let out = null;
  try { out = JSON.parse(fs.readFileSync(resultFile, "utf8")); } catch { /* reported below */ }
  console.log(`[ehc] secrets electron tests, ${phase} (exit ${code}${out?.waitedMs !== undefined ? `, save waited ${out.waitedMs} ms` : ""})`);
  if (!out) {
    console.log(`  FAIL no result file (Electron did not run the ${phase} phase) - ${stderr.slice(0, 400)}`);
    return { code, fail: 1 };
  }
  for (const c of out.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}${c.ok ? "" : ` - ${c.detail}`}`);
  if (out.crash) console.log("  CRASH " + out.crash.slice(0, 600));
  return { code, fail: out.fail, out };
}

const seal = await runPhase("seal");
const open = await runPhase("open", seal.out ? { EH_SEC_SEAL_PID: String(seal.out.pid), EH_SEC_BLOB: seal.out.blob ?? "" } : {});
const crashSeal = await runPhase("crash-seal");
const crashOpen = await runPhase("crash-open", crashSeal.out ? { EH_SEC_CRASH_PID: String(crashSeal.out.pid) } : {});

const phases = { seal, open, "crash-seal": crashSeal, "crash-open": crashOpen };
const failures = Object.values(phases).reduce((n, p) => n + p.fail, 0);
const badExit = Object.entries(phases).filter(([, p]) => p.code !== 0).map(([name]) => name);
console.log(failures === 0 && badExit.length === 0 ? "[ehc] secrets electron tests: ALL PASS" : `[ehc] secrets electron tests: ${failures} FAILURE(S)${badExit.length ? ` (non-zero exit: ${badExit.join(", ")})` : ""}`);
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
process.exit(failures === 0 && badExit.length === 0 ? 0 : 1);
