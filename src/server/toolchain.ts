// Event Horizon Code — Toolchain Doctor
// Probes PATH via languages/*/language.json toolchain.check. No installs. No network.

import { execFile } from "node:child_process";
import type { LanguagePack } from "./lsp";

export type ToolCheck = {
  lang: string;
  displayName: string;
  cmd: string;
  ok: boolean;
  version: string;
  error?: string;
};

function firstToken(check: string): { cmd: string; args: string[] } {
  const parts = check.trim().split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

// Probe output is displayed verbatim in the panel, so strip ANSI escapes and
// control characters (a failing tool can emit colour codes / binary noise that
// renders as blocks) and keep one readable line.
function sanitize(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")   // ANSI escapes
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") // other control chars
    .replace(/\s+/g, " ")
    .trim();
}

// Windows-launcher stubs fail with raw HRESULT text. Say what it means instead:
// C:\Windows\System32\bash.exe is the WSL launcher and reports "Catastrophic
// failure" when no distribution is installed.
function humanizeError(cmd: string, message: string): string {
  const m = sanitize(message);
  if (/catastrophic failure/i.test(m)) {
    return cmd === "bash" || cmd === "wsl"
      ? "not usable: WSL launcher present but no Linux distribution is installed"
      : "the tool failed to start (Windows error 0x8000FFFF) - it may be a launcher stub";
  }
  if (/ENOENT/i.test(m)) return "not installed (not on PATH)";
  if (/EACCES|permission denied/i.test(m)) return "found but not executable (permission denied)";
  if (/timed? ?out/i.test(m)) return "timed out while reporting its version";
  return m.slice(0, 160);
}

function probe(pack: LanguagePack, check: string): Promise<ToolCheck> {
  return new Promise<ToolCheck>((resolve) => {
    const { cmd, args } = firstToken(check);
    // windowsHide is load-bearing: under Electron (packaged or dev) spawning
    // console processes without it can stall for minutes on Windows - this is
    // why the panel sat on "Checking" forever in the GUI while curl was fine.
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout, stderr) => {
      const out = sanitize((stdout || stderr || "").split("\n")[0] ?? "").slice(0, 120);
      resolve({
        lang: pack.id,
        displayName: pack.displayName,
        cmd: check,
        ok: !err,
        version: out,
        // The real cause often lives in stderr, not err.message: e.g. the WSL
        // launcher's "Catastrophic failure" arrives on stderr.
        error: err ? humanizeError(cmd, `${String((err as Error).message)} ${String(stderr ?? "")}`) : undefined,
      });
    });
  });
}

// Concurrency-limited: ~90 probes at once is a process-creation storm; 6 at a
// time keeps the machine responsive and still finishes in a few seconds.
const CONCURRENCY = 6;

export async function runToolchainDoctor(packs: LanguagePack[]): Promise<ToolCheck[]> {
  const jobs: Array<() => Promise<ToolCheck>> = [];
  for (const p of packs) for (const c of p.toolchain.check) jobs.push(() => probe(p, c));
  const results: ToolCheck[] = [];
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      results.push(await job());
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return results;
}
