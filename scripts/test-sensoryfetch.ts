// Optional-download tests (Sensory catalog) - fully offline. Covers the public
// host allowlist, the ZIP reader, the download loop against a loopback stub,
// and the verify-then-install step with injected bytes. Nothing here reaches
// the internet, and nothing writes into the real sensory folder.
// Run: npm run sensoryfetch:test

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { allowedDownloadHop, allowedExternalUrl, INSTALL_PAGES } from "../src/shared/externals";
import { cleanTranscript, modelRank, pickModel } from "../src/server/sensory";
import { catalogStatus, download, FetchError, installItem, startFetch, type CatalogItem, type FetchJob, type FetchPhase } from "../src/server/sensoryfetch";
import { readZip } from "../src/server/unzip";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
async function rejects(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try { await (typeof p === "function" ? p() : p); return ""; } catch (e) { return String((e as Error)?.message ?? e); }
}

// ---- a tiny ZIP writer, so the reader is tested against real archive bytes ----
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    let c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(packed.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(packed.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    local.push(lh, name, packed);
    central.push(ch, name);
    offset += lh.length + name.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

async function stub(handler: http.RequestListener): Promise<{ url: string; cut: () => void; close: () => Promise<void> }> {
  const s = http.createServer(handler);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(s.address() as { port: number }).port}`,
    cut: () => s.closeAllConnections(),
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
}
const sha = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
const idle = (): AbortSignal => new AbortController().signal;
const mk = (id: string, bytes: Buffer, extra: Partial<CatalogItem> = {}): CatalogItem =>
  ({ id, kind: "model", label: id, note: "", file: `${id}.bin`, url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/x.bin", size: bytes.length, sha256: sha(bytes), ...extra });

async function main(): Promise<void> {
  console.log("[ehc] sensory download tests");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-sensoryfetch-"));
  process.env.EH_AUDIT_LOG = path.join(tmp, "audit.jsonl");

  // 1. Allowlist: the only public hosts anything may open or fetch from.
  check("https on an allowed host is accepted", allowedExternalUrl("https://github.com/ggml-org/whisper.cpp/releases") !== null);
  check("https on a subdomain of an allowed host is accepted", allowedExternalUrl("https://docs.docker.com/get-started/get-docker/") !== null);
  check("plain http is refused", allowedExternalUrl("http://github.com/x") === null);
  check("javascript: is refused", allowedExternalUrl("javascript:alert(1)") === null);
  check("file: is refused", allowedExternalUrl("file:///C:/Windows") === null);
  check("credentials in the URL are refused", allowedExternalUrl("https://user:pw@github.com/") === null);
  check("a host that is not on the list is refused", allowedExternalUrl("https://example.com/whisper.zip") === null);
  check("loopback is refused", allowedExternalUrl("http://127.0.0.1:8080/x") === null && allowedExternalUrl("https://127.0.0.1/x") === null);
  check("a look-alike host is refused", allowedExternalUrl("https://github.com.evil.test/x") === null);
  check("a CDN hop of an allowed host is accepted for downloads only", allowedDownloadHop("https://release-assets.githubusercontent.com/a") !== null && allowedExternalUrl("https://release-assets.githubusercontent.com/a") === null);
  check("a CDN hop over plain http is refused", allowedDownloadHop("http://release-assets.githubusercontent.com/a") === null);
  const pages = Object.entries(INSTALL_PAGES);
  check("every install page is https and on the allowlist", pages.every(([, u]) => allowedExternalUrl(u) === u), pages.filter(([, u]) => allowedExternalUrl(u) !== u).map(([k]) => k).join(","));
  check("the install pages span many distinct official sites", new Set(pages.map(([, u]) => new URL(u).hostname)).size > 35);
  // Every command the Doctor can probe must have somewhere to send the user.
  const packsDir = path.join(process.cwd(), "languages");
  const commands = new Set<string>();
  for (const lang of fs.existsSync(packsDir) ? fs.readdirSync(packsDir) : []) {
    try {
      const pack = JSON.parse(fs.readFileSync(path.join(packsDir, lang, "language.json"), "utf8")) as { toolchain?: { check?: string[] } };
      for (const c of pack.toolchain?.check ?? []) if (c.trim()) commands.add(c.trim().split(/\s+/)[0].replace(/\.exe$/i, "").toLowerCase());
    } catch { /* not a language pack */ }
  }
  const uncovered = [...commands].filter((c) => !INSTALL_PAGES[c]);
  check(`every probed command has an official install page (${commands.size} commands)`, commands.size > 50 && uncovered.length === 0, uncovered.join(", "));

  // 2. The pinned catalog.
  const cat = catalogStatus();
  check("catalog has engine rows and language models", cat.items.some((i) => i.kind === "engine") && cat.items.filter((i) => i.kind === "model").length >= 6);
  check("every catalog row is pinned with a size and a 64-hex sha256", cat.items.every((i) => i.size > 1000 && /^[0-9a-f]{64}$/.test(i.sha256)));
  check("every catalog URL is https on github.com or huggingface.co", cat.items.every((i) => /^https:\/\/(github\.com|huggingface\.co)\//.test(i.url) && allowedExternalUrl(i.url) !== null));
  const nope = await rejects(() => startFetch("nope"));
  check("an unknown id is refused with a 400-style error", nope !== "");
  let status = 0;
  try { startFetch("nope"); } catch (e) { if (e instanceof FetchError) status = e.status; }
  check("an unknown id is a FetchError 400", status === 400);

  // 3. ZIP reader.
  const a = Buffer.from("hello whisper");
  const b = Buffer.alloc(5000, 7);
  const zip = makeZip([{ name: "Release/whisper-cli.exe", data: a }, { name: "Release/ggml.dll", data: b, deflate: true }, { name: "Release/", data: Buffer.alloc(0) }]);
  const entries = readZip(zip);
  check("stored and deflated entries decode, names are flattened", entries.length === 2 && entries[0]!.name === "whisper-cli.exe" && entries[0]!.data.equals(a) && entries[1]!.data.equals(b));
  check("zip-slip entry names are refused", /unsafe entry name/.test(await rejects(() => readZip(makeZip([{ name: "../evil.exe", data: a }])))));
  check("backslash paths are refused", /unsafe entry name/.test(await rejects(() => readZip(makeZip([{ name: "C:\\evil.exe", data: a }])))));
  check("garbage is refused", /zip:/.test(await rejects(() => readZip(Buffer.from("this is not a zip archive at all, and it is long enough to scan for a record")))));
  const zip64 = Buffer.from(zip);
  zip64.writeUInt16LE(0xffff, zip64.length - 12);
  check("zip64 is refused", /zip64/.test(await rejects(() => readZip(zip64))));
  check("truncated archives are refused", (await rejects(() => readZip(zip.subarray(0, zip.length - 40)))) !== "");
  check("size caps hold", /beyond the size cap/.test(await rejects(() => readZip(zip, { maxBytes: 1000 }))));

  // 4. Download loop against a loopback stub (the allow hook is test-only).
  const payload = crypto.randomBytes(300_000);
  const progress: number[] = [];
  const ok = await stub((_req, res) => { res.writeHead(200, { "content-length": String(payload.length) }); res.end(payload); });
  const dest = path.join(tmp, "ok.bin");
  await download(ok.url, dest, { size: payload.length }, idle(), { allow: (u) => u, onProgress: (n) => progress.push(n) });
  check("bytes land on disk intact", fs.readFileSync(dest).equals(payload));
  check("progress is reported more than once, ending at the full size", progress.length > 1 && progress[progress.length - 1] === payload.length);
  check("a second write to the same path is refused", /EEXIST/.test(await rejects(() => download(ok.url, dest, { size: payload.length }, idle(), { allow: (u) => u }))));
  await ok.close();

  const hop = await stub((_req, res) => { res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" }); res.end(); });
  check("a redirect off the allowlist is refused", /redirected off the allowlist/.test(await rejects(() => download(hop.url, path.join(tmp, "hop.bin"), { size: 10 }, idle(), { allow: (u) => (u === hop.url ? u : null) }))));
  await hop.close();

  const big = await stub((_req, res) => { res.writeHead(200); res.end(Buffer.alloc(2000)); });
  const bigDest = path.join(tmp, "big.bin");
  check("more bytes than pinned aborts", /larger than its pinned size/.test(await rejects(() => download(big.url, bigDest, { size: 1000 }, idle(), { allow: (u) => u }))));
  check("an aborted download leaves no partial file", !fs.existsSync(bigDest));
  await big.close();

  const sad = await stub((_req, res) => { res.writeHead(404); res.end(); });
  check("an HTTP error is reported", /HTTP 404/.test(await rejects(() => download(sad.url, path.join(tmp, "sad.bin"), { size: 10 }, idle(), { allow: (u) => u }))));
  check("a failed download leaves no file", !fs.existsSync(path.join(tmp, "sad.bin")));
  await sad.close();

  const slow = await stub((_req, res) => { res.writeHead(200); res.write("x"); });
  check("a stalled download times out", /stalled/.test(await rejects(() => download(slow.url, path.join(tmp, "slow.bin"), { size: 10 }, idle(), { allow: (u) => u, stallMs: 150 }))));
  const ac = new AbortController();
  const cancelling = download(slow.url, path.join(tmp, "cancel.bin"), { size: 10 }, ac.signal, { allow: (u) => u });
  setTimeout(() => ac.abort(), 150);
  check("cancelling aborts and cleans up", (await rejects(() => cancelling)) !== "" && !fs.existsSync(path.join(tmp, "cancel.bin")));
  slow.cut();
  await slow.close();

  // The production default: no hook, a loopback address - refused, and the
  // stub can prove it was never contacted.
  let hit = false;
  const guard = await stub((_req, res) => { hit = true; res.end("should never be reached"); });
  check("the production allowlist refuses a non-listed host before connecting", /not on the download allowlist/.test(await rejects(() => download(guard.url, path.join(tmp, "guard.bin"), { size: 10 }, idle()))) && !hit && !fs.existsSync(path.join(tmp, "guard.bin")));
  await guard.close();

  // 5. Verify-then-install, with the fetch step replaced by injected bytes.
  const dir = path.join(tmp, "sensory");
  const run = async (item: CatalogItem, bytes: Buffer): Promise<FetchJob> => {
    let last: FetchJob = { id: item.id, label: item.id, phase: "connecting", bytes: 0, total: item.size, startedAt: 0 };
    await installItem(item, { dir, signal: idle(), set: (phase, patch) => { last = { ...last, phase, ...patch }; }, fetchFile: async (_url, destP) => { fs.writeFileSync(destP, bytes); } });
    return last;
  };
  const good = crypto.randomBytes(4096);
  const g = await run(mk("good", good), good);
  check("matching bytes are installed under the real name", g.phase === "done" && fs.readFileSync(path.join(dir, "good.bin")).equals(good));
  check("no .part file survives", fs.readdirSync(dir).every((f) => !f.endsWith(".part")));
  const bad = await run(mk("bad", good), crypto.randomBytes(4096));
  check("a hash mismatch installs nothing and says so", bad.phase === "error" && /checksum mismatch/.test(bad.error ?? "") && !fs.existsSync(path.join(dir, "bad.bin")));
  const short = await run(mk("short", good), good.subarray(0, 10));
  check("a truncated file fails the hash", short.phase === "error" && !fs.existsSync(path.join(dir, "short.bin")));
  const keep = /^(whisper-cli\.exe|whisper\.dll|ggml.*\.dll)$/;
  const e = await run(mk("engine", zip, { kind: "engine", file: "whisper-cli.exe", zip: true, keep }), zip);
  check("an engine archive installs only the allowlisted programs", e.phase === "done" && fs.existsSync(path.join(dir, "whisper-cli.exe")) && fs.readFileSync(path.join(dir, "ggml.dll")).equals(b));
  const wrongZip = makeZip([{ name: "Release/other.exe", data: a }]);
  const w = await run({ ...mk("wrongzip", wrongZip, { kind: "engine", file: "whisper-cli.exe", zip: true, keep }) }, wrongZip);
  check("an archive without the expected program installs nothing", w.phase === "error" && /does not contain/.test(w.error ?? ""));

  // 6. Model choice and transcript cleaning.
  const M = ["/s/ggml-tiny.en.bin", "/s/ggml-base.en.bin", "/s/ggml-small.bin", "/s/ggml-small.en.bin"];
  // Keys are looked up lower-cased (the Doctor normalises the command), so
  // "R" must be stored as "r" - a case slip here silently removed a link.
  check("install pages are keyed in lower case", Object.keys(INSTALL_PAGES).every((k) => k === k.toLowerCase()));
  check("with no language set, the best model's multilingual twin covers every language", pickModel(M)?.endsWith("ggml-small.bin") === true);
  check("English picks the best English-only model", pickModel(M, { language: "en" })?.endsWith("ggml-small.en.bin") === true);
  check("without a language no smaller model outranks a bigger one", pickModel(M, { language: "en" })?.endsWith("ggml-small.en.bin") === true && !pickModel(M)?.includes("base"));
  check("a non-English request prefers the multilingual twin", pickModel(["/s/ggml-small.bin", "/s/ggml-small.en.bin"], { language: "es" })?.endsWith("ggml-small.bin") === true);
  check("an explicit model wins", pickModel(M, { model: "ggml-base.en.bin" })?.endsWith("ggml-base.en.bin") === true);
  check("an unknown model is refused", pickModel(M, { model: "ggml-large-v3.bin" }) === null);
  check("a path cannot be smuggled through the model name", pickModel(M, { model: "../../etc/passwd" }) === null && pickModel(M, { model: "/s/ggml-small.en.bin/../../../x" }) === null);
  check("no models means no choice", pickModel([]) === null);
  check("model ranking", modelRank("ggml-large-v3-turbo.bin") > modelRank("ggml-large-v3.bin") && modelRank("ggml-medium.en.bin") > modelRank("ggml-small.en.bin") && modelRank("ggml-small.en.bin") > modelRank("ggml-base.en.bin") && modelRank("ggml-weird.bin") === 10);
  check("timestamps are stripped and lines joined", cleanTranscript("[00:00:00.000 --> 00:00:05.000]   And so my fellow\n\n[00:00:05.000 --> 00:00:11.000] Americans.\n") === "And so my fellow Americans.");
  check("an empty transcript is an empty string", cleanTranscript("\n\n") === "");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "[ehc] sensory download tests: ALL PASS" : `[ehc] sensory download tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] sensory download tests crashed:", e); process.exit(1); });
