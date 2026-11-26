// Session scratch: generate the pinned Sensory catalog straight from the
// source APIs (Hugging Face tree = published SHA-256 per file; GitHub release
// assets = published digest per asset), so no hash is ever hand-copied.
// Usage: node scripts/generate-sensory-catalog.mjs <outfile.ts> [verify.json]
// Regenerate when pinning a newer whisper.cpp release, then re-run the verification.
import fs from "node:fs";
const out = process.argv[2];
if (!out) { console.error('usage: generate-sensory-catalog.mjs <outfile.ts> [verify.json]'); process.exit(2); }
const hf = await (await fetch("https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main")).json();
const gh = await (await fetch("https://api.github.com/repos/ggml-org/whisper.cpp/releases/tags/b5907", { headers: { accept: "application/vnd.github+json", "user-agent": "ehc-catalog-gen" } })).json();
const models = {
  "ggml-tiny.en.bin": ["tiny.en", "Tiny - English", "Fastest; rough."],
  "ggml-base.en.bin": ["base.en", "Base - English", "Quick; fine for short commands."],
  "ggml-small.en.bin": ["small.en", "Small - English", "Recommended for English: noticeably more accurate, still about 5x faster than real time on a CPU."],
  "ggml-medium.en.bin": ["medium.en", "Medium - English", "Most accurate English; slower on a CPU."],
  "ggml-tiny.bin": ["tiny", "Tiny - multilingual", "~100 languages; rough."],
  "ggml-base.bin": ["base", "Base - multilingual", "~100 languages."],
  "ggml-small.bin": ["small", "Small - multilingual", "Recommended for languages other than English."],
  "ggml-large-v3-turbo.bin": ["large-v3-turbo", "Large v3 Turbo - multilingual", "Best accuracy across ~100 languages; needs a strong machine."],
};
const engines = {
  "whisper-bin-x64.zip": ["whisper-win-x64", "whisper.cpp for Windows x64", "x64"],
  "whisper-bin-win-cpu-arm64.zip": ["whisper-win-arm64", "whisper.cpp for Windows ARM64", "arm64"],
};
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const L = [];
L.push("// Event Horizon Code - pinned catalog for the OPTIONAL Sensory downloads.");
L.push("// GENERATED from the sources' own metadata (scripts/generate-sensory-catalog.mjs);");
L.push("// do not edit by hand. Each row: official URL, exact size, published SHA-256.");
L.push("// A file that does not match its pin is deleted, never installed.");
L.push("");
L.push("import type { CatalogItem } from \"./sensoryfetch\";");
L.push("");
L.push("const HF = \"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/\";");
L.push("const WHISPER = \"https://github.com/ggml-org/whisper.cpp/releases/download/b5907/\";");
L.push("// The release the engine rows are pinned to (kept in sync with WHISPER).");
L.push("export const WHISPER_RELEASE_URL = \"https://github.com/ggml-org/whisper.cpp/releases/tag/b5907\";");
L.push("");
L.push("export const SENSORY_CATALOG: CatalogItem[] = [");
for (const [asset, [id, label, arch]] of Object.entries(engines)) {
  const a = gh.assets.find((x) => x.name === asset);
  if (!a || !a.digest) throw new Error("missing asset/digest " + asset);
  L.push(`  { id: ${JSON.stringify(id)}, kind: "engine", label: ${JSON.stringify(label)}, note: "Official CPU build. Installs whisper-cli and its runtime DLLs; nothing else from the archive is kept.", file: "whisper-cli.exe", platform: "win32", arch: ${JSON.stringify(arch)}, zip: true, keep: /^(whisper-cli\\.exe|whisper\\.dll|ggml.*\\.dll|llama\\.dll)$/,`);
  L.push(`    url: WHISPER + ${JSON.stringify(asset)}, size: ${a.size}, sha256: ${JSON.stringify(a.digest.replace("sha256:", ""))} },`);
}
for (const [file, [id, label, note]] of Object.entries(models)) {
  const f = hf.find((x) => x.path === file);
  if (!f || !f.lfs) throw new Error("missing model " + file);
  L.push(`  { id: ${JSON.stringify(id)}, kind: "model", label: ${JSON.stringify(label)}, note: ${JSON.stringify(note)}, file: ${JSON.stringify(file)}, langs: ${JSON.stringify(file.includes(".en.") ? "en" : "multi")},`);
  L.push(`    url: HF + ${JSON.stringify(file)}, size: ${f.lfs.size}, sha256: ${JSON.stringify(f.lfs.oid)} },`);
}
L.push("];");
L.push("");
fs.writeFileSync(out, L.join("\n"));
// Also emit a verification list for check-catalog.mjs.
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify([
  ...Object.entries(engines).map(([asset]) => ({ file: asset, url: `https://github.com/ggml-org/whisper.cpp/releases/download/b5907/${asset}`, sha256: gh.assets.find((x) => x.name === asset).digest.replace("sha256:", ""), size: gh.assets.find((x) => x.name === asset).size })),
  ...Object.keys(models).map((file) => ({ file, url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`, sha256: hf.find((x) => x.path === file).lfs.oid, size: hf.find((x) => x.path === file).lfs.size })),
], null, 1));
console.log(`wrote ${out}: ${L.length} lines; ${Object.keys(engines).length} engines + ${Object.keys(models).length} models`);
