// Event Horizon Code — Local server (source of truth)
// Sessions, worktrees, tools, permissions, model router, engram service, SSE.

import crypto from "node:crypto";
import { loadLanguagePacks, LspManager } from "./lsp";
import { runToolchainDoctor } from "./toolchain";
import { detectPackageManager } from "./packageManager";
import { indexSymbols } from "./fallbackIndex";
import { checkSandboxTools, readWorktreeConfig } from "./sandbox";
import { isUnclean } from "./detonate";
import { startHttpServer } from "./http";
import { audit } from "./audit";
import { initStore } from "./store";
import { broadcast } from "./sse";

export async function startLocalServer(opts: { port: number; password: string }) {
  // Start minimal HTTP (127.0.0.1, Basic auth). Light, training-friendly.
  const storeMode = initStore();
  const httpServer = startHttpServer(opts);
  audit({ tool: "server.start", note: `port ${opts.port} store=${storeMode.mode}` });
  const packs = loadLanguagePacks();
  const lsp = new LspManager();
  // Wire diagnostics to SSE broadcast
  lsp.onDiagnostics = (worktree, lang, payload) => {
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

  // TODO Phase 1: HTTP + SSE, Basic auth, SQLite (better-sqlite3 WAL),
  // worktree manager (git worktree add/remove), tool registry, MCP client,
  // ACP-compatible endpoints:
  //   initialize, session/new, session/prompt, session/update,
  //   session/request_permission, fs/read_text_file
  //   GET /api/toolchain -> runToolchainDoctor(packs)
  //   POST /api/symbols -> indexSymbols fallback when LSP unavailable
  // Engram glue: import afterimage_* via Python subprocess (stdlib only),
  // never reimplement. See docs/ENGRAM_INTEGRATION.md
  void crypto.randomBytes(1);
  void lsp;
}
