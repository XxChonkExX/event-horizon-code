// Event Horizon Code — Engine manager (bundled chonkllama.cpp sidecar)
// Spawns the bundled llama-server (chonk-buffer branch, Vulkan + Chonk pool) on
// 127.0.0.1 when the user wants a one-stop local engine. Talks OpenAI /v1 — the
// router's chatOpenAI already speaks that dialect.
//
// House rules:
// - No model shipped or downloaded without the user asking.
// - GPU policy per docs/GPU.md: device pinning + heap fraction capped (B70 headroom).
// - Process hygiene: child tracked, killed on stop; no orphans.

import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type EngineConfig = {
  kind: "bundled" | "external" | "none";
  binaryPath: string;
  port: number;
  ggufDirs: string[];
  gpu: { deviceIndex: number; heapFraction: number; pool: boolean };
};

// Agnostic defaults: home runtime dir + repo-local models. Machine-specific
// paths are additions in config, never requirements.
export function defaultGgufDirs(): string[] {
  return [path.join(os.homedir(), ".eventhorizon", "models"), path.join(process.cwd(), "models")];
}

export function addGgufDir(dir: string): { ok: boolean; dirs: string[]; error?: string } {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return { ok: false, dirs: readEngineConfig().ggufDirs, error: `directory does not exist: ${abs}` };
  const cfgPath = path.join(process.cwd(), ".harness", "config.json");
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>; } catch { /* fresh config */ }
  const eng = (raw.engine as Partial<EngineConfig> | undefined) ?? {};
  const existing: string[] = eng.ggufDirs ?? [];
  if (!existing.includes(abs)) existing.push(abs);
  eng.ggufDirs = existing;
  raw.engine = eng;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
  return { ok: true, dirs: readEngineConfig().ggufDirs };
}

export function readEngineConfig(): EngineConfig {
  let raw: { engine?: Partial<EngineConfig> } = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { engine?: Partial<EngineConfig> };
  } catch { /* defaults below */ }
  // Agnostic dirs always present; config dirs are additions.
  const dirs = Array.from(new Set([...defaultGgufDirs(), ...(raw.engine?.ggufDirs ?? [])]));
  return {
    kind: raw.engine?.kind ?? "bundled",
    binaryPath: raw.engine?.binaryPath ?? "",
    port: raw.engine?.port ?? 8901,
    ggufDirs: dirs,
    gpu: raw.engine?.gpu ?? { deviceIndex: 0, heapFraction: 0.6, pool: true },
  };
}

// Engine binary ladder: explicit config -> env override -> packaged resources.
export function resolveEngineBinary(): { path: string | null; tried: string[] } {
  const cfg = readEngineConfig();
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const candidates = [
    ...(cfg.binaryPath ? [cfg.binaryPath] : []),
    ...(process.env.EH_ENGINE_BIN ? [process.env.EH_ENGINE_BIN] : []),
    path.join(process.cwd(), "resources", "engine", exe),
    path.join(path.dirname(process.execPath), "resources", "engine", exe),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return { path: c, tried: candidates };
  return { path: null, tried: candidates };
}

// ---- model registry: scan user dirs for GGUFs (filesystem-only, cheap) ----

export type GgufEntry = { name: string; path: string; sizeBytes: number; dir: string };

export function scanGgufDirs(dirs: string[], maxPerDir = 50): GgufEntry[] {
  const out: GgufEntry[] = [];
  for (const dir of dirs) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; } // missing dir = stated skip
    let n = 0;
    for (const e of entries) {
      if (!e.toLowerCase().endsWith(".gguf")) continue;
      if (n++ >= maxPerDir) break;
      const full = path.join(dir, e);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) out.push({ name: e, path: full, sizeBytes: st.size, dir });
      } catch { /* unreadable — skip, state nothing */ }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- sidecar lifecycle ----

let proc: ChildProcess | null = null;
let startedAt = 0;

export function engineRunning(): boolean { return proc !== null && proc.exitCode === null; }

export function engineEndpoint(): string | null {
  if (!engineRunning()) return null;
  return `http://127.0.0.1:${readEngineConfig().port}/v1`;
}

export type EngineOverrides = {
  heapFraction?: number;
  deviceIndex?: number | null; // null = pool spans all devices (multi-GPU)
  pool?: boolean;
  extraArgs?: string[];
  mmprojPath?: string; // vision encoder (mtmd) — pairs with VLM GGUFs
};

export function startEngine(ggufPath?: string, ov?: EngineOverrides): Promise<{ ok: boolean; note: string }> {
  const cfg = readEngineConfig();
  if (cfg.kind === "none") return Promise.resolve({ ok: false, note: "engine disabled in config (kind: none)" });
  if (engineRunning()) return Promise.resolve({ ok: true, note: `already running (pid ${proc?.pid}) on ${engineEndpoint()}` });
  const binary = resolveEngineBinary();
  const binPath = binary.path;
  if (!binPath) {
    return Promise.resolve({ ok: false, note: `engine binary not found — tried: ${binary.tried.join(", ")}` });
  }
  const model = ggufPath ?? "";
  if (!model || !fs.existsSync(model)) {
    return Promise.resolve({ ok: false, note: "no GGUF selected — pass a model path from GET /api/engine/models" });
  }
  const heapFraction = ov?.heapFraction ?? cfg.gpu.heapFraction;
  const pool = ov?.pool ?? cfg.gpu.pool;
  const deviceIndex = ov?.deviceIndex !== undefined ? ov.deviceIndex : cfg.gpu.deviceIndex;
  return new Promise((resolve) => {
    // Port-conflict guard: a stale llama-server holding the port makes the new
    // one die with EADDRINUSE while the old one keeps answering. Refuse loudly.
    let portBusy = false;
    if (process.platform === "win32") {
      try {
        const { execFileSync } = require("node:child_process");
        const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `if (Get-NetTCPConnection -LocalPort ${cfg.port} -State Listen -ErrorAction SilentlyContinue) { 'busy' } else { 'free' }`], { timeout: 8000, encoding: "utf8" });
        portBusy = String(out).trim() === "busy";
      } catch { portBusy = false; }
    }
    if (portBusy) {
      return resolve({ ok: false, note: `port ${cfg.port} already in use - stale engine holding it. Kill it (Get-Process llama-server) or change engine.port.` });
    }
    // Child stdout/stderr -> log file. A long-running server with an undrained
    // pipe buffer will eventually block — never leave it unread.
    const logDir = path.join(require("node:os").homedir(), ".eventhorizon");
    fs.mkdirSync(logDir, { recursive: true });
    const child = spawn(binPath, [
      "-m", model,
      "--host", "127.0.0.1",
      "--port", String(cfg.port),
      "-ngl", "99",
      ...(ov?.mmprojPath ? ["--mmproj", ov.mmprojPath] : []),
      ...(ov?.extraArgs ?? []),
    ], {
      env: {
        ...process.env,
        GGML_VK_VVM_POOL: pool ? "1" : "0",
        GGML_VVM_HEAP_FRACTION: String(heapFraction),
        // deviceIndex null => omit the pin so the Chonk pool spans every device.
        ...(deviceIndex !== null && deviceIndex !== undefined ? { VVM_DEVICE_INDEX: String(deviceIndex) } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"] as const,
      windowsHide: true,
    });
    const logPath = path.join(logDir, `engine-${child.pid ?? "x"}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);
    proc = child;
    startedAt = Date.now();
    const note = `engine starting (pid ${child.pid}) on http://127.0.0.1:${cfg.port} — model ${path.basename(model)} — log ${logPath}`;
    child.on("exit", (code) => {
      proc = null;
      logStream.end();
      void code;
    });
    // Wait briefly for the HTTP listener; health checked by caller.
    setTimeout(() => resolve({ ok: true, note }), 500);
  });
}

export function stopEngine(): { ok: boolean; note: string } {
  if (!proc) return { ok: true, note: "not running" };
  const pid = proc.pid;
  try { proc.kill(); } catch { /* already dead */ }
  proc = null;
  return { ok: true, note: `engine stopped (pid ${pid ?? "?"})` };
}

export function engineHealth(): Promise<{ running: boolean; healthy: boolean; endpoint: string | null; uptimeMs: number }> {
  const endpoint = engineEndpoint();
  if (!endpoint) return Promise.resolve({ running: engineRunning(), healthy: false, endpoint: null, uptimeMs: engineRunning() ? Date.now() - startedAt : 0 });
  // Node fetch, not execFile curl — PATH resolution without .exe fails on Windows.
  const base = endpoint.replace(/\/v1$/, "");
  return fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
    .then((r) => ({ running: true, healthy: r.ok, endpoint, uptimeMs: Date.now() - startedAt }))
    .catch(() => ({ running: true, healthy: false, endpoint, uptimeMs: Date.now() - startedAt }));
}

process.on("exit", () => { if (proc) { try { proc.kill(); } catch { /* ignore */ } } });

// ---- Sensory capability detection (S1): eyes/ears/mouth presence as stated facts ----

export type Sensory = {
  eyes: boolean;      // mtmd.dll next to the engine binary — vision capable
  ears: boolean;      // whisper-server.exe (planned sidecar)
  mouth: boolean;     // piper.exe / kokoro (planned sidecar)
  notes: string[];
};

export function sensoryDetect(): Sensory {
  const binary = resolveEngineBinary();
  if (!binary.path) return { eyes: false, ears: false, mouth: false, notes: [`engine binary not found — tried: ${binary.tried.join(", ")}`] };
  const dir = path.dirname(binary.path);
  const notes: string[] = [];
  let eyes = false, ears = false, mouth = false;
  try {
    eyes = fs.existsSync(path.join(dir, "mtmd.dll")) || fs.existsSync(path.join(dir, "mtmd.so"));
    ears = fs.existsSync(path.join(dir, "whisper-server.exe")) || fs.existsSync(path.join(dir, "whisper-server"));
    mouth = fs.existsSync(path.join(dir, "piper.exe")) || fs.existsSync(path.join(dir, "piper"));
    if (!eyes) notes.push("mtmd.dll not found next to engine — vision models will reject images");
    if (!ears) notes.push("whisper sidecar not bundled yet (Phase S2) — STT via BYOK or nothing");
    if (!mouth) notes.push("tts sidecar not bundled yet (Phase S2) — speech replies via BYOK or nothing");
  } catch {
    notes.push("engine dir unreadable — sensory detection failed");
  }
  return { eyes, ears, mouth, notes };
}
