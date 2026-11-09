// Event Horizon Code — Local server (source of truth)
// Sessions, worktrees, tools, permissions, model router, engram service, SSE.

import crypto from "node:crypto";

export async function startLocalServer(_opts: { port: number; password: string }) {
  // TODO Phase 1: HTTP + SSE, Basic auth, SQLite (better-sqlite3 WAL),
  // worktree manager (git worktree add/remove), tool registry, MCP client,
  // ACP-compatible endpoints:
  //   initialize, session/new, session/prompt, session/update,
  //   session/request_permission, fs/read_text_file
  // Engram glue: import afterimage_* via Python subprocess (stdlib only),
  // never reimplement. See docs/ENGRAM_INTEGRATION.md
  void crypto.randomBytes(1);
}
