// Event Horizon Code — PTY terminal manager (server side)
// node-pty (prebuilt via @lydell/node-pty) per worktree. Lazy require so headless
// runtime without the native module degrades gracefully instead of crashing.
// Process hygiene: every pty tracked; killAll on process exit. No orphans.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { audit } from "./audit";

// EH (sweep 3): caller-supplied environment must not be able to alter
// executable resolution or inject code loaders into the child process.
// Defense in depth - not a substitute for process isolation.
const BLOCKED_ENV = new Set([
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "ELECTRON_RUN_AS_NODE",
  "COMSPEC",
  // Sweep-5: executable-resolution variables - an overridden PATH/PATHEXT
  // decides which binary actually runs, so callers may never set them.
  "PATH",
  "PATHEXT",
]);

// Exported for the ACP security tests.
export function sanitizeTerminalEnv(supplied: Record<string, string> = {}): Record<string, string> {
  const result = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(supplied)) {
    const normalized = key.toUpperCase();
    if (BLOCKED_ENV.has(normalized)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof value !== "string" || value.length > 8192) continue;
    result[key] = value;
  }
  return result;
}

type PtyModule = {
  spawn: (file: string, args: string[], opts: Record<string, unknown>) => { pid: number; onData: (cb: (d: string) => void) => void; onExit: (cb: (e: { exitCode: number }) => void) => void; write: (d: string) => void; resize: (c: number, r: number) => void; kill: () => void };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
function ptyModule(): PtyModule | null { try { return require("@lydell/node-pty") as PtyModule; } catch { return null; } }

type TermExit = { exitCode: number | null; signal: number | null };

type TermSession = {
  id: string;
  worktree: string;
  pty: ReturnType<PtyModule["spawn"]>;
  // Command terminals (ACP): output is retained for terminal/output polling,
  // capped at the requested byte limit. Interactive shells leave these unset.
  command?: string;
  buffer?: string;
  truncated?: boolean;
  byteLimit?: number;
  exit?: TermExit | null;
  waiters?: Array<(e: TermExit) => void>;
};
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
  // Collision-resistant: two creations in the same millisecond must not
  // overwrite each other in the sessions Map (sweep-3 finding).
  const id = `term_${crypto.randomUUID()}`;
  const s: TermSession = { id, worktree: cwd, pty: p };
  sessions.set(id, s);
  audit({ tool: "terminal.open", note: `${id} pid=${p.pid} cwd=${cwd}${cwdNote ? ` (${cwdNote})` : ""}` });
  p.onExit(() => sessions.delete(id));
  return { ok: true, id, cwdNote };
}

export function getTerminal(id: string): TermSession | null { return sessions.get(id) ?? null; }

// node-pty's Windows conpty requires an existing file - a bare "node" throws
// "File not found". Resolve bare commands over PATH + PATHEXT, exactly like a
// shell would, before handing them to the pty.
function resolveExecutable(cmd: string): string {
  if (!cmd || cmd.includes("\\") || cmd.includes("/")) return cmd;
  const exts = [""].concat((process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";"));
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep searching */ }
    }
  }
  return cmd; // not found - the pty will state the error plainly
}

// ACP terminal/create: run a specific command in a PTY (not a shell), retain
// capped output for polling, and expose exit status. Untracked waiters are
// resolved on exit; the caller polls terminal/output for incremental text.
export function openCommandTerminal(
  worktree: string,
  command: string,
  args: string[],
  opts?: { outputByteLimit?: number; env?: Record<string, string> },
): { ok: boolean; id?: string; error?: string; cwdNote?: string } {
  const pty = ptyModule();
  if (!pty) return { ok: false, error: "node-pty native module unavailable - ACP terminals disabled (stated blind spot)" };
  if (!command.trim()) return { ok: false, error: "command required" };
  let cwd = path.resolve(worktree);
  let cwdNote: string | undefined;
  if (!fs.existsSync(cwd)) {
    const fallback = path.resolve(process.cwd());
    cwdNote = `requested worktree "${worktree}" does not exist - started in ${fallback}`;
    cwd = fs.existsSync(fallback) ? fallback : require("node:os").homedir();
  }
  const byteLimit = Math.max(1024, Math.min(opts?.outputByteLimit ?? 512_000, 4_000_000));
  const p = pty.spawn(resolveExecutable(command), args, {
    name: "xterm-256color", cols: 120, rows: 30, cwd,
    env: sanitizeTerminalEnv(opts?.env),
  });
  const id = `acpterm_${crypto.randomUUID()}`;
  const s: TermSession = { id, worktree: cwd, pty: p, command, buffer: "", truncated: false, byteLimit, exit: null, waiters: [] };
  sessions.set(id, s);
  audit({ tool: "terminal.open-command", note: `${id} pid=${p.pid} cmd=${command} cwd=${cwd}` });
  p.onData((d: string) => {
    if (s.exit) return;
    s.buffer = (s.buffer ?? "") + d;
    if (Buffer.byteLength(s.buffer, "utf8") > s.byteLimit!) {
      s.buffer = s.buffer.slice(0, s.byteLimit!);
      s.truncated = true;
    }
  });
  p.onExit((e: { exitCode: number }) => {
    s.exit = { exitCode: e.exitCode, signal: null };
    for (const w of s.waiters ?? []) { try { w(s.exit); } catch { /* waiter gone */ } }
    s.waiters = [];
  });
  return { ok: true, id, cwdNote };
}

// ACP terminal/output: the retained output so far plus exit status.
export function terminalBuffer(id: string): { ok: boolean; output?: string; truncated?: boolean; exit_code?: number | null; signal?: number | null; error?: string } {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: `no such terminal: ${id}` };
  return {
    ok: true,
    output: s.buffer ?? "",
    truncated: s.truncated ?? false,
    exit_code: s.exit ? s.exit.exitCode : null,
    signal: s.exit ? s.exit.signal : null,
  };
}

// ACP terminal/wait_for_exit. Resolves immediately if already exited; otherwise
// when the process exits. Optional timeoutMs bounds the HTTP request (0 = wait).
export function waitForTerminalExit(id: string, timeoutMs = 0): Promise<{ ok: boolean; exit_code?: number | null; signal?: number | null; error?: string }> {
  const s = sessions.get(id);
  if (!s) return Promise.resolve({ ok: false, error: `no such terminal: ${id}` });
  if (s.exit) return Promise.resolve({ ok: true, exit_code: s.exit.exitCode, signal: s.exit.signal });
  return new Promise((resolve) => {
    let done = false;
    const finish = (e: TermExit): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: true, exit_code: e.exitCode, signal: e.signal });
    };
    (s.waiters ??= []).push(finish);
    const timer = timeoutMs > 0 ? setTimeout(() => {
      if (done) return;
      done = true;
      s.waiters = (s.waiters ?? []).filter((w) => w !== finish);
      resolve({ ok: false, error: `terminal still running after ${timeoutMs}ms` });
    }, timeoutMs) : null;
  });
}

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
