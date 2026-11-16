// Event Horizon Code — Local server (source of truth)
// Sessions, worktrees, tools, permissions, model router, engram service, SSE.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLanguagePacks, lspManager } from "./lsp";
import { runToolchainDoctor } from "./toolchain";
import { detectPackageManager } from "./packageManager";
import { indexSymbols } from "./fallbackIndex";
import { checkSandboxTools, readWorktreeConfig } from "./sandbox";
import { isUnclean } from "./detonate";
import { startHttpServer } from "./http";
import { audit } from "./audit";
import { initStore } from "./store";
import { broadcast } from "./sse";

export async function startLocalServer(opts: { port: number; password: string; fatalOnPortConflict?: boolean }) {
  // Start minimal HTTP (127.0.0.1, Basic auth). Light, training-friendly.
  const storeMode = initStore();
  const httpServer = startHttpServer(opts);
  // Wait for the socket so callers (and the descriptor below) can trust it.
  await new Promise<void>((resolve, reject) => {
    if (httpServer.listening) { resolve(); return; }
    httpServer.once("ehc-listening", () => resolve());
    httpServer.once("ehc-listen-error", (err: Error) => reject(err));
    setTimeout(() => reject(new Error(`listen timeout on port ${opts.port}`)), 4000);
  });
  audit({ tool: "server.start", note: `port ${opts.port} store=${storeMode.mode}` });
  // Runtime descriptor: lets the Electron shell attach to THIS server instead
  // of forking a second one on a random port. Two servers on one SQLite file
  // made "works via curl, not in the app" a recurring mystery.
  try {
    const descriptor = path.join(os.homedir(), ".eventhorizon", "runtime.json");
    fs.mkdirSync(path.dirname(descriptor), { recursive: true });
    fs.writeFileSync(descriptor, JSON.stringify({ port: opts.port, password: opts.password, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  } catch { /* best-effort */ }
  const packs = loadLanguagePacks();
  // Wire diagnostics to SSE broadcast
  lspManager.onDiagnostics = (worktree, lang, payload) => {
    broadcast(worktree, "diagnostics", { lang, payload });
  };

  // Light startup only. No spawning. No network. Training-friendly.
  // GPU policy (see docs/GPU.md): UI on 7900 XTX, B70 32GB reserved for CodeRed-418, 8GB free.
  if (process.env.EH_DEBUG === "1") {
    void runToolchainDoctor(packs).then((checks) => {
      const ok = checks.filter((c) => c.ok).length;
      console.log(`[ehc] toolchain: ${ok}/${checks.length} ok`);
    });
    void detectPackageManager(process.cwd());
    void indexSymbols(process.cwd(), ".py");
    void checkSandboxTools().then((tools) => console.log("[ehc] sandbox:", tools.map((t) => `${t.tool}:${t.ok ? "ok" : "miss"}`).join(", ")));
    void readWorktreeConfig(process.cwd());
    void isUnclean("test payload");
  }

  // Phase 1 is done: HTTP + SSE, Basic auth, SQLite (better-sqlite3 WAL),
  // worktree manager, tool registry, MCP client, and the ACP subset
  // (initialize, session/new, session/prompt, session/update,
  // session/request_permission, fs/read_text_file). See docs/BACKEND.md
  // for what is still open beyond that.
  //   GET /api/toolchain -> runToolchainDoctor(packs)
  //   POST /api/symbols -> indexSymbols fallback when LSP unavailable
  // Engram glue: import afterimage_* via Python subprocess (stdlib only),
  // never reimplement. See docs/ENGRAM_INTEGRATION.md
  void crypto.randomBytes(1);
  void lspManager;
}
