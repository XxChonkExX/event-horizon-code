// Event Horizon Code — PTY terminal manager (server side)
// node-pty (prebuilt via @lydell/node-pty) per worktree. Lazy require so headless
// runtime without the native module degrades gracefully instead of crashing.
// Process hygiene: every pty tracked; killAll on process exit. No orphans.

import fs from "node:fs";
import path from "node:path";
import { audit } from "./audit";

type PtyModule = {
  spawn: (file: string, args: string[], opts: Record<string, unknown>) => { pid: number; onData: (cb: (d: string) => void) => void; onExit: (cb: (e: { exitCode: number }) => void) => void; write: (d: string) => void; resize: (c: number, r: number) => void; kill: () => void };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
function ptyModule(): PtyModule | null { try { return require("@lydell/node-pty") as PtyModule; } catch { return null; } }

type TermSession = { id: string; worktree: string; pty: ReturnType<PtyModule["spawn"]> };
const sessions = new Map<string, TermSession>();

export function ptyAvailable(): boolean { return ptyModule() !== null; }

function shellForPlatform(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
  return { file: process.env.SHELL ?? "bash", args: [] };
}

export function openTerminal(worktree: string): { ok: boolean; id?: string; error?: string; cwdNote?: string } {
  const pty = ptyModule();
  if (!pty) return { ok: false, error: "node-pty native module unavailable — terminal disabled (stated blind spot)" };
  // cwd validation: a missing folder makes the shell quit instantly on some
  // platforms. Fall back stated, never silently.
  let cwd = path.resolve(worktree);
  let cwdNote: string | undefined;
  if (!fs.existsSync(cwd)) {
    const fallback = path.resolve(process.cwd());
    cwdNote = `requested worktree "${worktree}" does not exist — started in ${fallback}`;
    cwd = fs.existsSync(fallback) ? fallback : require("node:os").homedir();
  }
  const { file, args } = shellForPlatform();
  const p = pty.spawn(file, args, { name: "xterm-256color", cols: 80, rows: 24, cwd, env: { ...process.env } });
  const id = `term_${Date.now().toString(36)}`;
  const s: TermSession = { id, worktree: cwd, pty: p };
  sessions.set(id, s);
  audit({ tool: "terminal.open", note: `${id} pid=${p.pid} cwd=${cwd}${cwdNote ? ` (${cwdNote})` : ""}` });
  p.onExit(() => sessions.delete(id));
  return { ok: true, id, cwdNote };
}

export function getTerminal(id: string): TermSession | null { return sessions.get(id) ?? null; }

export function terminalInput(id: string, data: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.pty.write(data);
  return true;
}

export function terminalResize(id: string, cols: number, rows: number): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.pty.resize(cols, rows);
  return true;
}

export function killTerminal(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  try { s.pty.kill(); } catch { /* already dead */ }
  sessions.delete(id);
  audit({ tool: "terminal.kill", note: id });
  return true;
}

export function killAllTerminals() {
  for (const id of Array.from(sessions.keys())) killTerminal(id);
}

process.on("exit", killAllTerminals);
