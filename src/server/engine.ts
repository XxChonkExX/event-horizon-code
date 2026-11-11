// Event Horizon Code — Engine manager (bundled chonkllama.cpp sidecar)
// Spawns the bundled llama-server (chonk-buffer branch, Vulkan + Chonk pool) on
// 127.0.0.1 when the user wants a one-stop local engine. Talks OpenAI /v1 — the
// router's chatOpenAI already speaks that dialect.
//
// House rules:
// - No model shipped or downloaded without the user asking.
// - GPU policy per docs/GPU.md: device pinning + heap fraction capped (B70 headroom).
// - Process hygiene: child tracked, killed on stop; no orphans.

import { spawn, ChildProcess, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type EngineConfig = {
  kind: "bundled" | "external" | "none";
  binaryPath: string;
  port: number;
  ggufDirs: string[];
  gpu: { deviceIndex: number; heapFraction: number; pool: boolean };
};

export function readEngineConfig(): EngineConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { engine?: Partial<EngineConfig> };
    return {
      kind: raw.engine?.kind ?? "none",
      binaryPath: raw.engine?.binaryPath ?? "resources/engine/llama-server.exe",
      port: raw.engine?.port ?? 8901,
      ggufDirs: raw.engine?.ggufDirs ?? [],
      gpu: raw.engine?.gpu ?? { deviceIndex: 0, heapFraction: 0.6, pool: true },
    };
  } catch {
    return { kind: "none", binaryPath: "resources/engine/llama-server.exe", port: 8901, ggufDirs: [], gpu: { deviceIndex: 0, heapFraction: 0.6, pool: true } };
  }
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

export function startEngine(ggufPath?: string): Promise<{ ok: boolean; note: string }> {
  const cfg = readEngineConfig();
  if (cfg.kind === "none") return Promise.resolve({ ok: false, note: "engine disabled in config (kind: none)" });
  if (engineRunning()) return Promise.resolve({ ok: true, note: `already running (pid ${proc?.pid}) on ${engineEndpoint()}` });
  if (!fs.existsSync(cfg.binaryPath)) {
    return Promise.resolve({ ok: false, note: `bundled engine not found at ${cfg.binaryPath} — install via EHC model manager or point engine.binaryPath at chonkllama.cpp build` });
  }
  const model = ggufPath ?? "";
  if (!model || !fs.existsSync(model)) {
    return Promise.resolve({ ok: false, note: "no GGUF selected — pass a model path from GET /api/engine/models" });
  }
  return new Promise((resolve) => {
    // Child stdout/stderr -> log file. A long-running server with an undrained
    // pipe buffer will eventually block — never leave it unread.
    const logDir = path.join(require("node:os").homedir(), ".eventhorizon");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "engine.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const child = spawn(cfg.binaryPath, [
      "-m", model,
      "--host", "127.0.0.1",
      "--port", String(cfg.port),
      "-ngl", "99",
    ], {
      env: {
        ...process.env,
        GGML_VK_VVM_POOL: cfg.gpu.pool ? "1" : "0",
        GGML_VVM_HEAP_FRACTION: String(cfg.gpu.heapFraction),
        VVM_DEVICE_INDEX: String(cfg.gpu.deviceIndex),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  return new Promise((resolve) => {
    execFile("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${endpoint.replace("/v1", "")}/health`], { timeout: 4000 }, (err, stdout) => {
      resolve({ running: true, healthy: !err && String(stdout).trim() === "200", endpoint, uptimeMs: Date.now() - startedAt });
    });
  });
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
  const cfg = readEngineConfig();
  const dir = path.dirname(cfg.binaryPath);
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
