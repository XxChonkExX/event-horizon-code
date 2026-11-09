// Event Horizon Code — Detonation chamber for unclean interactions
// Separate function from clean path. For questionable-alignment inputs:
// untrusted repos, pasted payloads, red-team artifacts, model-generated exploits,
// external tool output, and any /think:max exploration of dual-use content.
//
// Rules: no network, no credentials, no host FS writes, time-boxed, killed on timeout.
// Aligns with BlackICE engram_vm: pyvm, rv32, ti85, mathcheck, dataflow — deterministic, no syscalls.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type DetonateTier = "review" | "execute" | "redteam";
export type DetonatePolicy = {
  worktree: string;
  tier: DetonateTier;
  timeoutMs: number;
  maxOutputBytes: number;
  allowNetwork: false;
  allowCredentials: false;
};

export const DEFAULT_POLICY: Pick<DetonatePolicy, "timeoutMs" | "maxOutputBytes" | "allowNetwork" | "allowCredentials"> = {
  timeoutMs: 30_000,
  maxOutputBytes: 200_000,
  allowNetwork: false,
  allowCredentials: false,
};

// Heuristic: anything matching these patterns routes to detonation, never to host.
const UNCLEAN_PATTERNS = [
  /exploit/i, /payload/i, /shellcode/i, /reverse[-\s]?shell/i,
  /malware/i, /ransomware/i, /keylog/i, /c2\b/i,
  /\\\\?unc\\/, /\/dev\/tcp\//, /curl.+\|\s*sh/, /wget.+\|\s*sh/,
  /Invoke-Expression/, /FromBase64String/,
];

export function isUnclean(text: string): boolean {
  return UNCLEAN_PATTERNS.some((re) => re.test(text));
}

// Pure. Builds an isolated run plan. Nothing executes here.
export function buildDetonatePlan(worktree: string, tier: DetonateTier, artifactPath?: string): DetonatePolicy & { args: string[]; env: Record<string, string>; steps: string[] } {
  const name = path.basename(worktree);
  const steps = tier === "review"
    ? ["1. Static triage in microVM (no exec yet)", "2. engram_search for reference records", "3. Operator approves before execute"]
    : tier === "execute"
    ? ["1. Copy artifact to read-only mount in VM", "2. Run in pyvm / rv32 / ti85 harness (no syscalls, capped steps)", "3. Capture stdout/stderr, cap output", "4. Kill VM, diff host before/after"]
    : ["1. Full red-team lane (BlackICE class-targeted behavior)", "2. Engram injection + arithmetic ledger verify", "3. All tool output treated as untrusted, human re-review required"];

  const args = tier === "execute" || tier === "redteam"
    ? ["run", "--clone", `detonate-${name}`, worktree, "--network", "off"]
    : ["run", "--clone", `review-${name}`, worktree, "--network", "off"];

  return {
    worktree,
    tier,
    ...DEFAULT_POLICY,
    args,
    env: { EH_DETONATE: "1", EH_NETWORK: "off", EH_CREDENTIALS: "0" },
    steps: artifactPath ? [...steps, `artifact: ${artifactPath}`] : steps,
  };
}

// Execute inside sandbox. Light: timeout enforced, output capped, always kills.
export function runDetonate(plan: DetonatePolicy & { args: string[] }): Promise<{ code: number | null; out: string; killed: boolean }> {
  return new Promise((resolve) => {
    const cmd = "sbx";
    const child = execFile(cmd, plan.args, { cwd: plan.worktree, timeout: plan.timeoutMs, maxBuffer: plan.maxOutputBytes }, (err, stdout, stderr) => {
      const out = ((stdout as string) || "") + ((stderr as string) || "");
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: out.slice(0, plan.maxOutputBytes), killed: false });
    });
    child.on("error", () => resolve({ code: 1, out: "sbx not available — detonation requires sbx. Decline to fall back to host.", killed: false }));
    const killer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, out: "killed: timeout exceeded", killed: true }); }, plan.timeoutMs + 2000);
    child.on("close", () => clearTimeout(killer));
  });
}

// Post-run quarantine check: ensure host worktree unchanged except approved outputs.
export function quarantineCheck(hostWorktree: string, allowedRelPaths: string[] = []): { ok: boolean; changed: string[] } {
  // Placeholder for git status diff. Caller implements git status --porcelain and compares.
  void hostWorktree; void allowedRelPaths;
  return { ok: true, changed: [] };
}

export function worktreeConfigHasDetonate(worktree: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(worktree, ".eventhorizon", "worktree.json"), "utf8")) as { mode?: string };
    return raw.mode === "detonate";
  } catch { return false; }
}
