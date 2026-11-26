// Event Horizon Code - optional, user-initiated downloads for the Sensory
// sidecars (the whisper.cpp engine and its language models).
//
// Policy - zero telemetry, zero cloud, never forced: nothing here runs unless
// the user clicks a download in the Sensory panel, and the app is fully usable
// offline without any of it (a whisper.cpp installed by hand or by a package
// manager is detected the same way). Every item is pinned in
// sensory-catalog.ts - official host, exact size, published SHA-256 - and a
// file that does not match its pin is deleted, never installed. There is no
// update check and nothing reports home.

import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { allowedDownloadHop, allowedExternalUrl } from "../shared/externals";
import { audit } from "./audit";
import { SENSORY_CATALOG } from "./sensory-catalog";
import { sensoryDir } from "./sensory";
import { readTarGz } from "./targz";
import { readZip } from "./unzip";

export { SENSORY_CATALOG };

/** Project pages the Sensory panel links to (same allowlist as everything else). */
export const CATALOG_LINKS = {
  whisperRelease: "https://github.com/ggml-org/whisper.cpp/releases",
  whisperModels: "https://huggingface.co/ggerganov/whisper.cpp",
  piperRelease: "https://github.com/rhasspy/piper/releases",
};

export type CatalogItem = {
  id: string;
  kind: "engine" | "model";
  label: string;
  note: string;
  /** Engine: the program that must exist afterwards. Model: the file saved. */
  file: string;
  url: string;
  size: number;
  sha256: string;
  platform?: NodeJS.Platform;
  arch?: string;
  zip?: boolean;
  tarGz?: boolean;
  keep?: RegExp;
  langs?: "en" | "multi";
};

export type FetchPhase = "connecting" | "downloading" | "verifying" | "installing" | "done" | "error" | "cancelled";
export type FetchJob = { id: string; label: string; phase: FetchPhase; bytes: number; total: number; startedAt: number; error?: string };

export class FetchError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const TERMINAL: FetchPhase[] = ["done", "error", "cancelled"];
let job: FetchJob | null = null;
let abort: AbortController | null = null;

export function fetchState(): FetchJob | null {
  return job ? { ...job } : null;
}

/** The pinned catalog with what is already on disk and what applies to this machine. */
export function catalogStatus(): { dir: string; items: Array<CatalogItem & { installed: boolean; applies: boolean }> } {
  const dir = sensoryDir();
  return {
    dir,
    items: SENSORY_CATALOG.map((it) => ({
      ...it,
      applies: (!it.platform || it.platform === process.platform) && (!it.arch || it.arch === process.arch),
      installed: fs.existsSync(path.join(dir, it.file)),
    })),
  };
}

export function cancelFetch(): boolean {
  if (!job || TERMINAL.includes(job.phase)) return false;
  abort?.abort();
  return true;
}

/** Starts one download. One at a time; the id must be a catalog row. */
export function startFetch(id: string): FetchJob {
  if (job && !TERMINAL.includes(job.phase)) throw new FetchError(409, "a download is already running");
  const it = SENSORY_CATALOG.find((x) => x.id === id);
  if (!it) throw new FetchError(400, `unknown download "${id.slice(0, 40)}"`);
  if (it.platform && it.platform !== process.platform) throw new FetchError(400, "this build is for another operating system");
  if (catalogStatus().items.find((x) => x.id === id)?.installed) throw new FetchError(409, "already installed");
  job = { id, label: it.label, phase: "connecting", bytes: 0, total: it.size, startedAt: Date.now() };
  abort = new AbortController();
  // Each start gets a token: a run that finishes after a newer one began must
  // not write into the newer job's state.
  const token = ++runToken;
  void installItem(it, { dir: sensoryDir(), signal: abort.signal, set: (phase, patch) => {
    if (token === runToken && job) job = { ...job, phase, ...patch };
  } });
  return { ...job };
}
let runToken = 0;

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

/**
 * Fetch, verify, install for one catalog row. The pinned hash is checked
 * BEFORE anything lands under its real name; a mismatch deletes the file.
 * `io.fetchFile` exists so the test can run this offline.
 */
export async function installItem(it: CatalogItem, io: { dir: string; signal: AbortSignal; set: (phase: FetchPhase, patch?: Partial<FetchJob>) => void; fetchFile?: typeof download }): Promise<void> {
  const dir = io.dir;
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, `.${it.id}-${Date.now().toString(36)}.part`);
  const set = (phase: FetchPhase, patch?: Partial<FetchJob>): void => io.set(phase, patch);
  try {
    await (io.fetchFile ?? download)(it.url, part, it, io.signal, { onProgress: (bytes, total) => set("downloading", { bytes, total }) });
    set("verifying");
    const actual = await sha256File(part);
    if (actual !== it.sha256) throw new Error(`checksum mismatch (expected ${it.sha256.slice(0, 12)}, got ${actual.slice(0, 12)}) - the file was deleted and nothing was installed`);
    set("installing");
    if (it.zip || it.tarGz) {
      // Archives: keep only the allowlisted programs and libraries, flat, and
      // (tar) restore the unix mode and the symlinks the loader needs.
      const entries = it.zip
        ? readZip(fs.readFileSync(part), { maxBytes: 128 * 1024 * 1024 }).map((e) => ({ name: e.name, mode: 0o755, type: "file" as const, link: undefined as string | undefined, data: e.data }))
        : readTarGz(fs.readFileSync(part), { maxBytes: 256 * 1024 * 1024 });
      const kept = entries.filter((e) => (e.type === "symlink" || e.type === "file") && it.keep?.test(e.name));
      if (!kept.some((e) => e.type === "file" && e.name === it.file)) throw new Error("the archive does not contain the expected program");
      for (const e of kept.sort((a, b) => (a.type === "symlink" ? 1 : 0) - (b.type === "symlink" ? 1 : 0))) {
        const dest = path.join(dir, e.name);
        if (e.type === "symlink" && e.link) {
          try { fs.unlinkSync(dest); } catch { /* did not exist */ }
          try {
            fs.symlinkSync(e.link, dest);
          } catch {
            // Where symlinks are refused (some filesystems, Windows without
            // developer mode), a copy of the target serves the dynamic loader
            // just as well. The target may itself be a link installed a moment
            // ago - links are written last, so it is already a real file.
            const target = path.resolve(dir, e.link);
            const root = path.resolve(dir);
            if (!target.startsWith(root + path.sep)) throw new Error("tar: link target escapes the install directory");
            fs.copyFileSync(target, dest);
          }
        }
        else if (e.data) fs.writeFileSync(dest, e.data, { mode: (e.mode & 0o777) || 0o644 });
      }
    } else {
      fs.renameSync(part, path.join(dir, it.file));
    }
    audit({ tool: "sensory.fetch", note: `${it.id} installed (${it.size} bytes, sha256 verified)` });
    set("done", { bytes: it.size });
  } catch (e) {
    const cancelled = io.signal.aborted;
    const message = String((e as Error)?.message ?? e).slice(0, 240);
    audit({ tool: "sensory.fetch", note: `${it.id} ${cancelled ? "cancelled" : "failed"}: ${message}` });
    set(cancelled ? "cancelled" : "error", cancelled ? {} : { error: message });
  } finally {
    fs.rmSync(part, { force: true });
  }
}

const allowHop = (u: string): string | null => allowedExternalUrl(u) ?? allowedDownloadHop(u);

/**
 * Streams `url` to `dest` (which must not exist). The first address and every
 * redirect hop are checked against the allowlist; the byte count may not
 * exceed the pinned size; 60 s without data aborts. `hooks` exist so the test
 * can point this at a loopback stub - production passes nothing.
 */
export async function download(
  url: string,
  dest: string,
  spec: { size: number },
  signal: AbortSignal,
  hooks: { onProgress?: (bytes: number, total: number) => void; allow?: (u: string) => string | null; fetchImpl?: typeof fetch; stallMs?: number } = {},
): Promise<void> {
  const allow = hooks.allow ?? allowHop;
  const fetchImpl = hooks.fetchImpl ?? fetch;
  let current = allow(url);
  if (!current) throw new Error("refused: the address is not on the download allowlist");
  const local = new AbortController();
  const stop = () => local.abort(signal.reason);
  if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => local.abort(new Error("the download stalled (no data for 60 s)")), hooks.stallMs ?? 60_000);
  };
  try {
    for (let hop = 0; ; hop++) {
      local.signal.throwIfAborted();
      arm();
      const res = await fetchImpl(current, { redirect: "manual", signal: local.signal, headers: { "user-agent": "event-horizon-code" } });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) throw new Error(`download failed (HTTP ${res.status} without a target)`);
        if (hop >= 5) throw new Error("download failed: too many redirects");
        current = allow(new URL(location, current).href);
        if (!current) throw new Error("refused: the download was redirected off the allowlist");
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
      const total = Number(res.headers.get("content-length")) || spec.size;
      let n = 0;
      const out = fs.createWriteStream(dest, { flags: "wx", mode: 0o600 });
      try {
        // "wx": an existing file is an error, and it must surface here as a
        // rejection - not later as an unhandled stream event.
        await once(out, "open");
        for await (const chunk of Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>)) {
          arm();
          n += chunk.byteLength;
          if (n > spec.size) throw new Error("the file is larger than its pinned size - aborted");
          hooks.onProgress?.(n, total);
          if (!out.write(chunk)) await once(out, "drain");
        }
        out.end();
        await finished(out);
      } catch (e) {
        out.destroy();
        throw e;
      }
      return;
    }
  } catch (e) {
    // Never leave a half-written file behind, whatever went wrong.
    fs.rmSync(dest, { force: true });
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
}
