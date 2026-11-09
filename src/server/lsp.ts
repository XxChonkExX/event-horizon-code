// Event Horizon Code — LSP/DAP manager
// Reads languages/<id>/language.json, spawns lazily per worktree, max 6 per worktree.
// No bundled runtimes. No auto-install. stdlib only (fs, child_process).

import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";

export type LanguagePack = {
  id: string;
  displayName: string;
  tier: number;
  fileExtensions: string[];
  toolchain: { check: string[]; managers?: string[] };
  lsp: { command: string[] };
  dap: { command: string[] };
  formatter: { command: string[] };
  linter: { command: string[] };
  commands: { build: string; test: string; run: string };
  treeSitter: { grammar: string };
  engramPack: string;
  skill: string;
};

function languagesRoot(): string {
  // languages/ lives at repo root; in packaged app it is in resources/
  const candidates = [
    path.join(process.cwd(), "languages"),
    path.join(path.dirname(process.execPath), "resources", "languages"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return path.join(process.cwd(), "languages");
}

export function loadLanguagePacks(): LanguagePack[] {
  const root = languagesRoot();
  if (!fs.existsSync(root)) return [];
  const packs: LanguagePack[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "language.json");
    if (!fs.existsSync(file)) continue;
    try {
      packs.push(JSON.parse(fs.readFileSync(file, "utf8")) as LanguagePack);
    } catch {
      // Ignore malformed pack; Toolchain Doctor will flag it
    }
  }
  return packs.sort((a, b) => a.tier - b.tier || a.displayName.localeCompare(b.displayName));
}

export function resolveLanguageForFile(filePath: string, packs: LanguagePack[]): LanguagePack | null {
  const ext = path.extname(filePath).toLowerCase();
  return packs.find((p) => p.fileExtensions.includes(ext)) ?? null;
}

type ServerEntry = {
  proc: ChildProcess;
  lang: string;
  worktree: string;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_PER_WORKTREE = 6;
const IDLE_EXIT_MS = 5 * 60 * 1000;

export class LspManager {
  private servers = new Map<string, Map<string, ServerEntry>>(); // worktree -> lang -> entry

  // Multiplex diagnostics to all windows via callback (wired to SSE in index.ts)
  onDiagnostics: (worktree: string, lang: string, payload: unknown) => void = () => {};

  spawnForFile(worktree: string, filePath: string, packs: LanguagePack[]): LanguagePack | null {
    const pack = resolveLanguageForFile(filePath, packs);
    if (!pack) return null;
    let byLang = this.servers.get(worktree);
    if (!byLang) { byLang = new Map(); this.servers.set(worktree, byLang); }
    const existing = byLang.get(pack.id);
    if (existing) {
      existing.lastUsed = Date.now();
      this.bumpTimer(worktree, pack.id, existing);
      return pack;
    }
    if (byLang.size >= MAX_PER_WORKTREE) {
      // Evict LRU
      const oldest = Array.from(byLang.values()).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      this.kill(worktree, oldest.lang);
    }
    const [cmd, ...args] = pack.lsp.command;
    // Spawn with stdio pipes for JSON-RPC 2.0. Content-Length framing handled by next step.
    const proc = spawn(cmd, args, {
      cwd: worktree,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });
    const entry: ServerEntry = { proc, lang: pack.id, worktree, lastUsed: Date.now(), timer: undefined as never };
    entry.timer = setTimeout(() => this.kill(worktree, pack.id), IDLE_EXIT_MS);
    byLang.set(pack.id, entry);
    proc.on("exit", () => byLang?.delete(pack.id));
    proc.stdout?.on("data", (chunk: Buffer) => {
      // TODO: parse Content-Length headers, forward diagnostics via onDiagnostics
      void chunk;
    });
    void proc.stderr?.on("data", () => {});
    return pack;
  }

  private bumpTimer(worktree: string, lang: string, entry: ServerEntry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.kill(worktree, lang), IDLE_EXIT_MS);
  }

  kill(worktree: string, lang: string) {
    const byLang = this.servers.get(worktree);
    const entry = byLang?.get(lang);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.proc.kill();
    byLang?.delete(lang);
    if (byLang && byLang.size === 0) this.servers.delete(worktree);
  }

  killWorktree(worktree: string) {
    const byLang = this.servers.get(worktree);
    if (!byLang) return;
    for (const lang of Array.from(byLang.keys())) this.kill(worktree, lang);
    this.servers.delete(worktree);
  }
}
