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
  // Sweep-3 #19: the artifact is now first-class on the plan so runners can
  // verify and deliver it (previous plan only mentioned it in the steps text).
  artifactPath?: string;
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

// Static gate for scripts offered to the clean-path sandbox (run_js). These
// constructs are either vm-escape attempts (constructor chains, dynamic
// Function, __proto__), host access (require, process, node:), or network
// (fetch, WebAssembly). Property access on `process` is caught, so a script
// grepping for the word "process" is not.
const SCRIPT_GATE: Array<[RegExp, string]> = [
  [/\brequire\s*\(/, "require()"],
  [/\bimport\s*\(/, "dynamic import()"],
  [/^\s*import\s+[^;]*\bfrom\b/m, "static import statement"],
  [/\bprocess\s*[.[]/, "process access"],
  [/\bglobalThis\b/, "globalThis access"],
  [/\bFunction\s*\(/, "dynamic Function()"],
  [/\beval\s*\(/, "eval()"],
  [/\.constructor\b|\[\s*["']constructor["']\s*\]/, "constructor-chain access"],
  [/__proto__/, "__proto__ access"],
  [/\bfetch\s*\(/, "network fetch()"],
  [/\bWebAssembly\b/, "WebAssembly"],
  [/\bimportScripts\b/, "importScripts()"],
  [/\bchild_process\b/, "child_process reference"],
  [/\bnode:/, "node: builtin module reference"],
];

export function scanUncleanScript(code: string): string[] {
  const hits: string[] = [];
  for (const [re, label] of SCRIPT_GATE) if (re.test(code)) hits.push(label);
  return hits;
}

// Pure. Builds an isolated run plan. Nothing executes here.
export function buildDetonatePlan(worktree: string, tier: DetonateTier, artifactPath?: string): DetonatePolicy & { args: string[]; env: Record<string, string>; steps: string[] } {
  const name = path.basename(worktree);
  const steps = tier === "review"
    ? ["1. Static triage in microVM (no exec yet)", "2. engram_search for reference records", "3. Operator approves before execute"]
    : tier === "execute"
    // Sweep-5 honesty: artifact DELIVERY into the VM is not implemented yet -
    // these steps describe the intended pipeline, not demonstrated behavior.
    ? ["1. INTENDED: deliver artifact into the VM (delivery not yet implemented)", "2. INTENDED: run in the VM harness", "3. INTENDED: capture output, cap size", "4. INTENDED: kill VM, diff host before/after"]
    : ["1. Full red-team lane (BlackICE class-targeted behavior)", "2. Engram injection + arithmetic ledger verify", "3. All tool output treated as untrusted, human re-review required"];

  const args = tier === "execute" || tier === "redteam"
    ? ["run", "--clone", `detonate-${name}`, worktree, "--network", "off"]
    : ["run", "--clone", `review-${name}`, worktree, "--network", "off"];

  return {
    worktree,
    tier,
    ...DEFAULT_POLICY,
    artifactPath,
    args,
    env: { EH_DETONATE: "1", EH_NETWORK: "off", EH_CREDENTIALS: "0" },
    steps: artifactPath ? [...steps, `artifact (metadata only - delivery NOT implemented): ${artifactPath}`] : steps,
  };
}

// Execute inside sandbox. Light: timeout enforced, output capped, always kills.
// A missing sbx is a stated refusal, never a silent fallback to the host.
export function runDetonate(plan: DetonatePolicy & { args: string[] }): Promise<{ code: number | null; out: string; killed: boolean; missing?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const refuse = (): void => {
      if (settled) return;
      settled = true;
      resolve({ code: 1, out: "sbx is not installed - the detonation lane requires sbx (microVM). Install sbx, or use tier=review. Refusing to fall back to the host.", killed: false, missing: true });
    };
    const cmd = "sbx";
    const child = execFile(cmd, plan.args, { cwd: plan.worktree, timeout: plan.timeoutMs, maxBuffer: plan.maxOutputBytes }, (err, stdout, stderr) => {
      if (settled) return;
      // ENOENT: sbx is absent. refuse() owns the settled flag - do not set it
      // here first, or refuse bails and the promise never resolves (the caller
      // then hangs forever while the event loop drains).
      if (err && (err as { code?: unknown }).code === "ENOENT") return refuse();
      settled = true;
      const out = ((stdout as string) || "") + ((stderr as string) || "");
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: out.slice(0, plan.maxOutputBytes), killed: false });
    });
    child.on("error", refuse);
    const killer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, out: "killed: timeout exceeded", killed: true });
    }, plan.timeoutMs + 2000);
    child.on("close", () => clearTimeout(killer));
  });
}

// Post-run quarantine check: ensure host worktree unchanged except approved outputs.
// Real git status --porcelain comparison. Allowed paths are rel-paths that may change.
export function quarantineCheck(hostWorktree: string, allowedRelPaths: string[] = []): { ok: boolean; changed: string[] } {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: hostWorktree, timeout: 5000, encoding: "utf8" }) as string;
    const changed = out.split("\n").filter(Boolean).map((l) => l.slice(3).trim());
    const allowed = new Set(allowedRelPaths);
    const bad = changed.filter((f) => !allowed.has(f));
    return { ok: bad.length === 0, changed: bad };
  } catch {
    // If git is unavailable, treat as quarantine failure - stated blind spot, operator must review.
    return { ok: false, changed: ["git status unavailable"] };
  }
}

// Sweep-5: capture the PRE-execution status. Detonation verification compares
// AFTER against BEFORE, so pre-existing uncommitted changes cannot cause false
// failures - and modifications to already-dirty files are still detected.
export function quarantineBaseline(hostWorktree: string): { ok: boolean; files: Set<string>; dirtyContent: Map<string, string> } {
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: hostWorktree, timeout: 5000, encoding: "utf8" }) as string;
    const files = new Set<string>();
    const dirtyContent = new Map<string, string>();
    for (const line of out.split("\n").filter(Boolean)) {
      const status = line.slice(0, 2);
      const file = line.slice(3).trim();
      files.add(file);
      // Content fingerprint for already-modified tracked files: a detonated
      // script that edits a dirty file changes its hash even if git status
      // still reports it as modified.
      try {
        if (status.trim().startsWith("M") || status.trim() === "AM") {
          dirtyContent.set(file, execFileSync("git", ["hash-object", path.join(hostWorktree, file)], { cwd: hostWorktree, timeout: 5000, encoding: "utf8" }).trim());
        }
      } catch { /* unreadable file - status comparison still applies */ }
    }
    return { ok: true, files, dirtyContent };
  } catch {
    return { ok: false, files: new Set(), dirtyContent: new Map() };
  }
}

// Compare AFTER vs BEFORE: only NEW changes (not in the baseline) or content
// drift on baseline-dirty files count as quarantine violations.
export function quarantineDiff(hostWorktree: string, baseline: { files: Set<string>; dirtyContent: Map<string, string> }, allowedRelPaths: string[] = []): { ok: boolean; changed: string[] } {
  const post = quarantineCheck(hostWorktree);
  const allowed = new Set(allowedRelPaths);
  const bad: string[] = [];
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: hostWorktree, timeout: 5000, encoding: "utf8" }) as string;
    for (const line of out.split("\n").filter(Boolean)) {
      const file = line.slice(3).trim();
      if (allowed.has(file)) continue;
      if (!baseline.files.has(file)) bad.push(file); // NEW change
      else if (baseline.dirtyContent.has(file)) {
        // Was already dirty - only a violation if its content hash changed.
        let hash = "";
        try {
          hash = execFileSync("git", ["hash-object", path.join(hostWorktree, file)], { cwd: hostWorktree, timeout: 5000, encoding: "utf8" }).trim();
        } catch { /* keep empty */ }
        if (hash && hash !== baseline.dirtyContent.get(file)) bad.push(`${file} (content changed)`);
      }
    }
    return { ok: bad.length === 0, changed: bad };
  } catch {
    return { ok: false, changed: ["git status unavailable"] };
  }
}

export function worktreeConfigHasDetonate(worktree: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(worktree, ".eventhorizon", "worktree.json"), "utf8")) as { mode?: string };
    return raw.mode === "detonate";
  } catch { return false; }
}
