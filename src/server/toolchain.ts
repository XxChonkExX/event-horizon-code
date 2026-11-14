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

function probe(pack: LanguagePack, check: string): Promise<ToolCheck> {
  return new Promise<ToolCheck>((resolve) => {
    const { cmd, args } = firstToken(check);
    // windowsHide is load-bearing: under Electron (packaged or dev) spawning
    // console processes without it can stall for minutes on Windows — this is
    // why the panel sat on "Checking" forever in the GUI while curl was fine.
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout, stderr) => {
      const out = (stdout || stderr || "").trim().split("\n")[0]?.slice(0, 120) ?? "";
      resolve({
        lang: pack.id,
        displayName: pack.displayName,
        cmd: check,
        ok: !err,
        version: out,
        error: err ? String((err as Error).message).slice(0, 200) : undefined,
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
