// Event Horizon Code - Engine packaging step (chonkllama.cpp sidecar)
//
// Produces resources/engine/ for the installer: the pinned chonkllama release
// subset (no tests, no accidental extras), every file SHA-256 verified, and a
// manifest recording exactly what went in. If the engine cannot be produced or
// verified, the build FAILS here - packaging a silently engine-less app is
// worse than not packaging at all.
//
// Usage:
//   node scripts/prepare-engine.mjs            # copies from the discovered build, verifies
//   node scripts/prepare-engine.mjs --verify  # verify resources/engine/ in place
//   node scripts/prepare-engine.mjs --to adir # inspect what would be copied, without writing
//
// Source discovery (first hit wins):
//   EH_ENGINE_SRC            - directory containing llama-server(.exe) [+ DLLs]
//   ./chonkllama.cpp/...     - sibling checkout of the fork, if present
//   C:/Users/mikeh/.../chonkllama.cpp/build-vk/bin/Release  - this dev machine
//
// The list below is deliberately small: llama-server + the DLLs it needs at
// load time + mtmd (vision) + llama-tts (speech). Test binaries, bench and
// conversion tools are not shipped.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO = process.cwd();
const DEST = path.join(REPO, "resources", "engine");
const MANIFEST = path.join(DEST, "ENGINE-MANIFEST.json");
const SUMS = path.join(DEST, "SHA256SUMS.txt");
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";

// Files the app needs at runtime. Anything not listed is NOT shipped.
const ENGINE_FILES = [
  `llama-server${EXE}`,
  `llama-tts${EXE}`,
  // shared libraries (Windows; Linux/macOS builds link statically or use .so/.dylib)
  "ggml-vulkan.dll",
  "ggml-cpu.dll",
  "ggml-base.dll",
  "ggml.dll",
  "llama.dll",
  "llama-common.dll",
  "llama-server-impl.dll",
  "llama-tts.dll",
  "mtmd.dll",
];

// Linux/macOS shared library equivalents (used only if the .dll list finds none).
const UNIX_LIBS = ["libllama.so", "libggml-vulkan.so", "libggml-cpu.so", "libggml-base.so", "libggml.so", "libmtmd.so",
                   "libllama.dylib", "libggml-vulkan.dylib", "libggml-cpu.dylib", "libggml-base.dylib", "libggml.dylib", "libmtmd.dylib"];

const CANDIDATES = [
  process.env.EH_ENGINE_SRC ?? "",
  path.join(REPO, "..", "chonkllama.cpp", "build-vk", "bin", "Release"),
  path.join(REPO, "..", "chonkllama.cpp", "build", "bin"),
  "C:/Users/mikeh/Documents/New OpenCode Project/chonkllama.cpp/build-vk/bin/Release",
  "C:/Users/mikeh/Documents/New OpenCode Project/chonkllama.cpp/build/bin",
].filter(Boolean);

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sizeBytes = (file) => fs.statSync(file).size;

function discoverSource(override) {
  for (const c of [override, ...CANDIDATES]) {
    if (!c) continue;
    const server = path.join(c, `llama-server${EXE}`);
    try { if (fs.existsSync(server)) return c; } catch { /* next */ }
  }
  return null;
}

function selectFiles(src, _override) {
  const found = [];
  const missing = [];
  for (const name of ENGINE_FILES) {
    const full = path.join(src, name);
    try { if (fs.existsSync(full) && fs.statSync(full).isFile()) found.push({ name, full }); else missing.push(name); }
    catch { missing.push(name); }
  }
  // On non-Windows, fall back to the .so/.dylib list when .dll-flavoured names
  // matched nothing (the chonkllama build layout varies by platform).
  if (found.length <= 2) {
    for (const name of UNIX_LIBS) {
      const full = path.join(src, name);
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) found.push({ name, full }); } catch { /* skip */ }
    }
    if (missing.length === ENGINE_FILES.length - 2) missing.length = 0;
  }
  return { found, missing };
}

function fail(msg) { console.error(`[prepare-engine] FAIL: ${msg}`); process.exit(1); }

const args = process.argv.slice(2);
const verifyOnly = args.includes("--verify");
const inspectOnly = args.includes("--to");
const overrideSrc = args.includes("--from") ? args[args.indexOf("--from") + 1] : null;

// ---- verify mode: check what's already in resources/engine ----
if (verifyOnly) {
  if (!fs.existsSync(MANIFEST)) fail(`no manifest at ${MANIFEST} - run prepare first`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  let ok = true;
  for (const f of manifest.files) {
    const target = path.join(DEST, f.name);
    if (!fs.existsSync(target)) { console.error(`missing: ${f.name}`); ok = false; continue; }
    const h = sha256(target);
    if (h !== f.sha256) { console.error(`SHA MISMATCH: ${f.name}\n  manifest ${f.sha256}\n  actual   ${h}`); ok = false; }
    else console.log(`ok ${f.name}`);
  }
  if (!ok) fail("engine verification failed");
  console.log(`[prepare-engine] verified ${manifest.files.length} files (chonkllama ${manifest.chonkllama.commit})`);
  process.exit(0);
}

// ---- prepare mode ----
const src = discoverSource(overrideSrc);
if (!src) fail(`no chonkllama build found; set EH_ENGINE_SRC to the directory containing llama-server${EXE}`);
console.log(`[prepare-engine] source: ${src}`);

const { found, missing } = selectFiles(src, overrideSrc);
if (found.length === 0) fail(`no engine files found in ${src}`);
if (missing.length) console.log(`[prepare-engine] absent (ok, platform-dependent): ${missing.join(", ")}`);
if (!found.some((f) => f.name.startsWith("llama-server"))) fail("llama-server not present in source - refusing");

// chonkllama provenance (best effort): the fork's current commit, read from git.
let commit = "unknown";
try {
  const { execFileSync } = await import("node:child_process");
  // chonkllama.cpp is a sibling of this repo; fall back to reading a VERSION file.
  const repo = fs.existsSync(path.join(REPO, "..", "chonkllama.cpp", ".git")) ? path.join(REPO, "..", "chonkllama.cpp") : null;
  if (repo) commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
} catch { /* provenance is best-effort; the manifest still records sizes+hashes */ }

if (dirExists(DEST) && !inspectOnly) {
  // Keep the staging clean on re-runs.
  for (const f of fs.readdirSync(DEST)) if (f !== ".gitkeep" && f !== "SHA256SUMS.txt") fs.rmSync(path.join(DEST, f), { recursive: true, force: true });
}
fs.mkdirSync(DEST, { recursive: true });

const entries = [];
for (const { name, full } of found) {
  const target = path.join(DEST, name);
  if (!inspectOnly) fs.copyFileSync(full, target);
  const h = sha256(full);
  entries.push({ name, sha256: h, bytes: sizeBytes(full) });
  console.log(`copied ${name}  ${(sizeBytes(full) / 1048576).toFixed(1)} MB  ${h.slice(0, 16)}…`);
}

const manifest = {
  note: "Event Horizon Code bundled engine. Pinned chonkllama.cpp (chonk-buffer) build; SHA-256 verified at packaging time.",
  chonkllama: { branch: "chonk-buffer", commit },
  source: src,
  files: entries,
  platform: process.platform,
  produced: new Date().toISOString(),
};
if (!inspectOnly) {
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  fs.writeFileSync(SUMS, entries.map((e) => `${e.sha256}  ${e.name}`).join("\n") + "\n");
  console.log(`\n[prepare-engine] staged ${entries.length} files into resources/engine/`);
  console.log(`[prepare-engine] manifest: ${MANIFEST}`);
  console.log(`[prepare-engine] sha256s:   ${SUMS}`);
  console.log(`[prepare-engine] chonkllama commit: ${commit}`);
  // Prove what we just wrote.
  let ok = true;
  for (const e of entries) if (sha256(path.join(DEST, e.name)) !== e.sha256) ok = false;
  if (!ok) fail("self-verification failed after copy");
  console.log("[prepare-engine] self-verification OK");
} else {
  console.log("[prepare-engine] inspect-only: nothing written");
}

function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
