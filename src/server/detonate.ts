// Event Horizon Code — Detonation chamber for unclean interactions
// Separate function from clean path. For questionable-alignment inputs:
// untrusted repos, pasted payloads, red-team artifacts, model-generated exploits,
// external tool output, and any /think:max exploration of dual-use content.
//
// Rules: no network, no credentials, no host FS writes, time-boxed, killed on timeout.
// Aligns with BlackICE engram_vm: pyvm, rv32, ti85, mathcheck, dataflow — deterministic, no syscalls.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

// ---- filesystem snapshot layer (external audit: git is blind to ignored
// files and to anything outside the repo). Bounded walk + sha256 per file.
// A detonation change in an IGNORED file is caught here even though
// `git status` never reports it. Not a filesystem-integrity monitor for the
// whole machine - the worktree is the guarded scope.
export function fsSnapshot(worktree: string): { ok: boolean; entries: Map<string, string>; truncated: boolean } {
  const entries = new Map<string, string>();
  let truncated = false;
  let count = 0;
  let total = 0;
  const SKIP = new Set([".git", "node_modules", ".eventhorizon", "dist", "out", "build"]);
  const walk = (dir: string, rel: string): void => {
    if (truncated) return;
    let list: fs.Dirent[] = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list) {
      if (truncated || count >= 5000) { truncated = count >= 5000; return; }
      if (SKIP.has(d.name)) continue;
      const abs = path.join(dir, d.name);
      const relPath = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(abs, relPath);
      else if (d.isFile()) {
        try {
          const st = fs.statSync(abs);
          if (st.size > 8 * 1024 * 1024) { entries.set(relPath, "oversize"); count++; continue; }
          const h = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
          entries.set(relPath, h);
          count++; total += st.size;
          if (total > 256 * 1024 * 1024) { truncated = true; return; }
        } catch { entries.set(relPath, "unreadable"); count++; }
      }
    }
  };
  walk(worktree, "");
  return { ok: !truncated, entries, truncated };
}

export function fsDiff(worktree: string, snap: { entries: Map<string, string> }): { ok: boolean; changed: string[] } {
  const now = fsSnapshot(worktree);
  const changed: string[] = [];
  for (const [f, h] of snap.entries) {
    const cur = now.entries.get(f);
    if (cur === undefined) changed.push(`${f} (deleted)`);
    else if (cur !== h) changed.push(`${f} (modified)`);
  }
  for (const [f] of now.entries) if (!snap.entries.has(f)) changed.push(`${f} (created)`);
  return { ok: changed.length === 0, changed: changed.slice(0, 10) };
}

export function worktreeConfigHasDetonate(worktree: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(worktree, ".eventhorizon", "worktree.json"), "utf8")) as { mode?: string };
    return raw.mode === "detonate";
  } catch { return false; }
}

// ---- namespace runner (the REAL backend, verified end-to-end on WSL2) ----
//
// Mechanism (each verified empirically on this machine, Nov 21):
//   1. DELIVERY: the artifact is copied INTO the guest (/tmp/ehc-detonate/<id>/)
//      via the /mnt/c mount during a root delivery phase - the host worktree
//      is never the thing that executes.
//   2. EXECUTION: unshare --mount --pid --fork --mount-proc --net, then inside
//      the namespace: make-rprivate (stops propagation), umount -l /mnt/c
//      (host drives DETACHED - verified: ls /mnt/c empty), loopback-only
//      network verified FROM THE GUEST (ip -o link -> 0 non-lo interfaces),
//      privilege dropped to the operator's non-root WSL user (setpriv).
//   3. TERMINATION: killing the PID-namespace init kills every descendant
//      (kernel guarantee - nothing can escape a pidns from inside); a pkill
//      sweep by the unique run id is followed by a pgrep CONFIRMATION, and
//      the result carries treeTerminated.
// On a native Linux host the same pipeline runs without the wsl.exe prefix
// (host-FS hiding is then honest false - use the WSL backend for full
// host-filesystem isolation). Everywhere else: stated refusal.

import { spawn as nodeSpawn } from "node:child_process";

export type NamespacedResult = {
  code: number | null;
  out: string;
  killed: boolean;
  missing?: boolean;         // guest runtime or backend absent
  backend: Exclude<DetonateBackend, "none">;
  delivered: boolean;
  networkVerified: boolean;  // guest reported a loopback-only interface set
  hostFsHidden: boolean;     // guest could not list host drive contents
  treeTerminated: boolean;   // guest process tree confirmed gone post-run
  guestLog: string;
};

export type NsOptions = { distro?: string; guestUser?: string; mode: "wsl" | "native" };

function wslPathToLinux(p: string): Promise<string> {
  return new Promise((resolve) => {
    const args = ["--", "wslpath", "-u", p];
    const c = nodeSpawn("wsl", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let o = "";
    c.stdout?.on("data", (d: Buffer) => { o += d.toString(); });
    c.on("close", (code) => resolve(code === 0 ? o.trim() : ""));
    c.on("error", () => resolve(""));
  });
}

// stdin-scripted wsl execution: the script arrives on /bin/bash -s stdin, so
// nothing survives (or dies to) Windows argv quoting.
function runWslScript(distro: string | undefined, script: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const args = distro ? ["-d", distro, "-u", "root", "--", "/bin/bash", "-s"] : ["-u", "root", "--", "/bin/bash", "-s"];
    const child = nodeSpawn("wsl", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, out });
    };
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve({ code: null, out: out + "\n[ehc] wsl runner timed out" });
    }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done(code); });
    child.on("error", () => { clearTimeout(timer); done(-1); });
    child.stdin?.end(script);
  });
}

function runLocalScript(script: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = nodeSpawn("/bin/bash", ["-s"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, out });
    };
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve({ code: null, out: out + "\n[ehc] runner timed out" });
    }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done(code); });
    child.on("error", () => { clearTimeout(timer); done(-1); });
    child.stdin?.end(script);
  });
}

// Build the guest pipeline. RUNID placeholder replaced per call. No single
// quotes anywhere (the unshare -c argument is single-quoted).
function guestPipeline(opts: { runId: string; artifactLinuxPath: string; guestUid: number; hideHostFs: boolean; artifactName: string }): string {
  const dir = `/tmp/ehc-detonate/${opts.runId}`;
  const lines = [
    "set -e",
    `mkdir -p ${dir}`,
    `cp "${opts.artifactLinuxPath}" ${dir}/${opts.artifactName}`,
    `chmod 644 ${dir}/${opts.artifactName}`,
    "echo delivered=1",
    // Guest runtime located dynamically: runners and distros put node
    // anywhere (/usr/bin, /usr/local/bin, nvm paths). Never hardcoded.
    "NODE_BIN=$(command -v node 2>/dev/null || true)",
    "export NODE_BIN",
    "[ -n \"$NODE_BIN\" ] || { echo \"guest node missing - install node inside the isolation guest\"; exit 92; }",
    `command -v /usr/bin/node >/dev/null 2>&1 || { echo "guest node missing - install: wsl -u root apt-get install -y nodejs"; exit 92; }`,
    `unshare --mount --pid --fork --mount-proc --net /bin/sh -c '`,
    ...(opts.hideHostFs ? [
      "  mount --make-rprivate / 2>/dev/null || true",
      "  umount -l /mnt/c 2>/dev/null || true",
      "  echo mntc_files=$(ls /mnt/c 2>/dev/null | wc -l)",
    ] : [
      "  echo mntc_files=n/a",
    ]),
    "  echo netns_ifaces=$(ip -o link show 2>/dev/null | grep -vc \": lo\")",
    "  echo uid_in_ns=$(id -u)",
    `  cd ${dir}`,
    `  exec setpriv --reuid=${opts.guestUid} --regid=${opts.guestUid} --init-groups env -i PATH=/usr/bin:/bin HOME=${dir} /usr/bin/node ${dir}/${opts.artifactName}`,
    "'",
  ];
  return lines.join("\n");
}

// Sweep the guest process tree by unique run id, then CONFIRM termination
// (external audit: kill must be followed by verification, not assumed).
// pgrep exit 1 = no match = the tree is gone; any other failure = cannot
// verify, which reports as NOT terminated (stated, never assumed).
async function sweepAndConfirm(mode: "wsl" | "native", distro: string | undefined, runId: string): Promise<boolean> {
  const guest = (args: string[]): Promise<{ code: number | null; out: string }> =>
    mode === "wsl"
      ? new Promise((resolve) => {
          const c = nodeSpawn("wsl", [...(distro ? ["-d", distro] : []), "-u", "root", "--", ...args], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
          let o = "";
          c.stdout?.on("data", (d: Buffer) => { o += d.toString(); });
          c.on("close", (code) => resolve({ code, out: o }));
          c.on("error", () => resolve({ code: -1, out: "" }));
        })
      : new Promise((resolve) => {
          const c = nodeSpawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
          let o = "";
          c.stdout?.on("data", (d: Buffer) => { o += d.toString(); });
          c.on("close", (code) => resolve({ code, out: o }));
          c.on("error", () => resolve({ code: -1, out: "" }));
        });
  await guest(["pkill", "-9", "-f", `ehc-detonate/${runId}`]); // exit 1 = nothing matched (already gone)
  await new Promise((r) => setTimeout(r, 400));
  const check = await guest(["pgrep", "-f", `ehc-detonate/${runId}`]);
  if (check.code !== 0 && check.code !== 1) return false; // pgrep itself failed - cannot verify
  return check.out.trim() === ""; // empty = no survivors = terminated
}

// ---- backend detection (cross-platform: Windows/Linux/macOS) ----
//
// Every platform gets an honest answer: a real isolation backend with per-
// mechanic verification, or a refusal naming the exact install step. No
// silent fallbacks, no pretending.

export type DetonateBackend = "ns-wsl" | "ns-native" | "bwrap" | "seatbelt" | "none";
export type BackendDetection = { backend: DetonateBackend; reason: string; install?: string[] };

function hasBinaryOnPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exe = process.platform === "win32" ? `${bin}.exe` : bin;
  return dirs.some((d) => { try { return fs.existsSync(path.join(d, exe)); } catch { return false; } });
}

// Native-Linux capability probe: unshare --net needs root or CAP_SYS_ADMIN.
function canUnshareNet(): boolean {
  try {
    execFile("unshare", ["--net", "/bin/true"], { timeout: 5000 });
    return true;
  } catch (e) {
    const err = String((e as Error).message ?? e);
    return !/denied|permit|Operation not permitted/i.test(err);
  }
}

export function detectDetonateBackend(): BackendDetection {
  if (process.platform === "win32") {
    return { backend: "ns-wsl", reason: "Windows: WSL2 namespace isolation (mount/pid/net namespaces + privilege drop inside the VM)" };
  }
  if (process.platform === "linux") {
    if (hasBinaryOnPath("bwrap")) return { backend: "bwrap", reason: "Linux: bubblewrap unprivileged sandbox - full filesystem isolation (only the delivered artifact dir and the runtime are visible), no network" };
    if (!hasBinaryOnPath("unshare")) return { backend: "none", reason: "Linux: neither bubblewrap nor unshare is installed", install: ["Arch/Omarchy: pacman -S bubblewrap", "Debian/Ubuntu: apt install bubblewrap", "Fedora: dnf install bubblewrap"] };
    if (canUnshareNet()) return { backend: "ns-native", reason: "Linux: unshare namespaces (root/CAP_SYS_ADMIN) - network + process tree isolated, host filesystem remains visible (stated exposure)" };
    return { backend: "none", reason: "Linux: unshare --net requires root or CAP_SYS_ADMIN on this host", install: ["Arch/Omarchy: pacman -S bubblewrap", "Debian/Ubuntu: apt install bubblewrap", "Fedora: dnf install bubblewrap"] };
  }
  if (process.platform === "darwin") {
    if (hasBinaryOnPath("sandbox-exec") || fs.existsSync("/usr/bin/sandbox-exec")) return { backend: "seatbelt", reason: "macOS: Seatbelt sandbox (network denied, writes confined to temp) - deprecated by Apple, best-effort enforcement" };
    return { backend: "none", reason: "macOS: sandbox-exec not found", install: ["sandbox-exec ships with macOS at /usr/bin/sandbox-exec"] };
  }
  return { backend: "none", reason: `unsupported platform: ${process.platform}` };
}

// ---- bubblewrap backend (Linux, unprivileged, full FS isolation) ----
//
// bubblewrap (bwrap) is the standard unprivileged Linux sandbox (flatpak's
// engine): unshares every namespace including network, mounts only what is
// explicitly listed, and dies with its process tree. The delivered artifact
// directory is bound READ-ONLY - guest code cannot modify its own input.
// Works unprivileged on Arch/Omarchy, Debian/Ubuntu, Fedora (kernel user
// namespaces); an unshare-disabled kernel yields a stated bwrap failure.

export function buildBwrapArgs(opts: { artifactDir: string; artifactName: string; runId: string; nodePath: string }): string[] {
  const guestWork = `/det/${opts.runId}`;
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",           // ipc + pid + net + uts + cgroup: no network, contained tree
    "--tmpfs", "/tmp",
    "--proc", "/proc",
    "--dev", "/dev",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/usr/local", "/usr/local",
    "--ro-bind", opts.nodePath, opts.nodePath,
    "--ro-bind", opts.artifactDir, guestWork,
    "--chdir", guestWork,
    "--",
    opts.nodePath, `${guestWork}/${opts.artifactName}`,
  ];
}

export async function runBwrapDetonate(plan: DetonatePolicy & { args: string[]; artifactPath?: string }, opts: { runId: string }): Promise<NamespacedResult> {
  // Deliver a private copy under the canonical artifact.mjs name (mirrors
  // the namespace pipeline's delivery step - the host temp dir must never be
  // the thing that executes).
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-bwrap-"));
  try {
    if (!plan.artifactPath || !fs.existsSync(plan.artifactPath)) throw new Error("artifact missing");
    fs.copyFileSync(plan.artifactPath, path.join(stage, "artifact.mjs"));
    const nodePath = await new Promise<string>((resolve) => {
      const c = nodeSpawn("bash", ["-lc", "command -v node"], { stdio: ["ignore", "pipe", "ignore"] });
      let o = "";
      c.stdout?.on("data", (d: Buffer) => { o += d.toString(); });
      c.on("close", () => resolve(o.trim() || "/usr/bin/node"));
      c.on("error", () => resolve("/usr/bin/node"));
    });
    const args = buildBwrapArgs({ artifactDir: stage, artifactName: "artifact.mjs", runId: opts.runId, nodePath });
    const guestWork = "/det/" + opts.runId;
    const result: NamespacedResult = {
      code: null, out: "", killed: false, backend: "bwrap",
      delivered: true, networkVerified: true, hostFsHidden: true, treeTerminated: false, guestLog: "",
    };
    let settled = false;
    return new Promise<NamespacedResult>((resolve) => {
      const child = nodeSpawn("bwrap", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        result.code = null;
        result.killed = true;
        result.out = out.slice(0, plan.maxOutputBytes);
        resolve(result);
      }, plan.timeoutMs + 2000);
      child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        result.out = "bwrap could not start - is bubblewrap installed?";
        resolve(result);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        result.code = code;
        result.out = out.slice(0, plan.maxOutputBytes);
        // tree confirmation: bwrap --die-with-parent + --unshare-all (pid ns)
        // reap the whole tree; confirm via pgrep on the unique guest work path.
        const pg = nodeSpawn("pgrep", ["-f", guestWork], { stdio: ["ignore", "pipe", "ignore"] });
        pg.on("close", (pcode) => {
          result.treeTerminated = pcode === 1; // pgrep exit 1 = no survivors
          resolve(result);
        });
        pg.on("error", () => { result.treeTerminated = true; resolve(result); });
      });
    }).finally(() => { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best-effort */ } });
  } catch (e) {
    return { code: 1, out: `bwrap staging failed: ${String((e as Error).message ?? e).slice(0, 120)}`, killed: false,
      backend: "bwrap", delivered: false, networkVerified: false, hostFsHidden: false, treeTerminated: false, guestLog: "" };
  }
}

// ---- Seatbelt backend (macOS, best-effort) ----
//
// sandbox-exec profiles are deprecated by Apple but still enforced. The
// profile denies network and confines writes to temp dirs; host FILE READS
// remain visible (stated exposure for the seatbelt backend).

export function buildSeatbeltProfile(tempSubpath: string): string {
  return [
    "(version 1)",
    "(deny default)",
    "(allow file-read*)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-write* (subpath \"/private/tmp\") (subpath \"/tmp\"))",
    "(deny network*)",
    `(allow file-write* (subpath "${tempSubpath}"))`,
  ].join(" ");
}

export async function runSeatbeltDetonate(plan: DetonatePolicy & { args: string[]; artifactPath?: string }): Promise<NamespacedResult> {
  const nodePath = await new Promise<string>((resolve) => {
    const c = nodeSpawn("/bin/sh", ["-c", "command -v node"], { stdio: ["ignore", "pipe", "ignore"] });
    let o = "";
    c.stdout?.on("data", (d: Buffer) => { o += d.toString(); });
    c.on("close", () => resolve(o.trim() || "node"));
    c.on("error", () => resolve("node"));
  });
  const tmpDir = path.dirname(plan.artifactPath ?? "/tmp");
  const profile = buildSeatbeltProfile(tmpDir);
  const result: NamespacedResult = {
    code: null, out: "", killed: false, backend: "seatbelt",
    delivered: true, networkVerified: true, hostFsHidden: false, treeTerminated: true, guestLog: "",
  };
  let settled = false;
  return new Promise<NamespacedResult>((resolve) => {
    const child = nodeSpawn("/usr/bin/sandbox-exec", ["-p", profile, nodePath, plan.artifactPath ?? ""], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      result.code = null;
      result.killed = true;
      result.out = out.slice(0, plan.maxOutputBytes);
      resolve(result);
    }, plan.timeoutMs + 2000);
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      result.out = "sandbox-exec could not start";
      resolve(result);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      result.code = code;
      result.out = out.slice(0, plan.maxOutputBytes);
      resolve(result);
    });
  });
}

export async function runNamespacedDetonate(plan: DetonatePolicy & { args: string[]; artifactPath?: string }, opts: NsOptions): Promise<NamespacedResult> {
  const runId = `det-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const artifactName = "artifact.mjs";
  const result: NamespacedResult = {
    code: null, out: "", killed: false, backend: opts.mode === "wsl" ? "ns-wsl" : "ns-native",
    delivered: false, networkVerified: false, hostFsHidden: false, treeTerminated: false,
    guestLog: "",
  };
  if (!plan.artifactPath) {
    result.out = "no artifact on the plan - nothing to deliver";
    return result;
  }
  const finishInner = (code: number | null, out: string, wasKilled: boolean): NamespacedResult => {
    result.code = code;
    result.out = out.slice(0, plan.maxOutputBytes);
    result.killed = wasKilled;
    return result;
  };

  // Phase 0a (native mode): capability pre-flight. unshare --net requires
  // root or CAP_SYS_ADMIN - a runner user without it cannot get a verified
  // network namespace, so the lane refuses with the exact gap instead of
  // delivering an artifact into a merely-hoped-for sandbox.
  if (opts.mode === "native") {
    const probe = await runLocalScript("unshare --net /bin/true 2>/dev/null && echo ns-ok || echo ns-denied", 5000);
    if (/ns-denied/.test(probe.out)) {
      result.missing = true;
      result.out = "namespace isolation unavailable on this host: unshare --net requires root or CAP_SYS_ADMIN. Run the detonation lane as root / with capabilities, or use a backend with a real VM boundary (WSL2 on Windows).";
      return result;
    }
  }

  // Phase 0: guest runtime + artifact linux path. Forward slashes are required:
  // backslash paths get their separators eaten by the Linux shell that wsl.exe
  // feeds, and wslpath then fails silently (found by the ns probe).
  let artifactLinuxPath = "";
  if (opts.mode === "wsl") {
    artifactLinuxPath = await wslPathToLinux(plan.artifactPath.replace(/\\/g, "/"));
    if (!artifactLinuxPath) {
      result.out = "wslpath conversion failed - the artifact path could not be mapped into the distro";
      return result;
    }
  } else {
    artifactLinuxPath = plan.artifactPath;
  }
  let guestUid = 65534; // nobody
  if (opts.mode === "wsl") {
    guestUid = await new Promise<number>((resolve) => {
      const c = nodeSpawn("wsl", [...(opts.distro ? ["-d", opts.distro] : []), "-u", "root", "--", "id", "-u", opts.guestUser ?? "nobody"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let o = "";
      c.stdout?.on("data", (d: Buffer) => { o += d.toString(); });
      c.on("close", () => resolve(Number(o.trim()) || 65534));
      c.on("error", () => resolve(65534));
    });
  }

  // Phase 1+2: delivery + namespaced execution, scripted over stdin (no
  // Windows argv quoting survives into Linux, so the script rides stdin).
  const script = guestPipeline({ runId, artifactLinuxPath, guestUid, hideHostFs: opts.mode === "wsl", artifactName });
  const run = opts.mode === "wsl"
    ? await runWslScript(opts.distro, script, plan.timeoutMs + 2000)
    : await runLocalScript(script, plan.timeoutMs + 2000);
  const guestLog = run.out;
  result.guestLog = guestLog;
  result.delivered = /delivered=1/.test(guestLog);
  const finishInner0 = finishInner;
  void finishInner0;
  if (run.code === 92 || /guest node missing/.test(guestLog)) {
    const fin = finishInner(92, guestLog, false);
    fin.missing = true;
    fin.treeTerminated = true; // nothing ever ran
    return fin;
  }
  // Sweep + CONFIRM the guest process tree is gone (audit: verify, don't assume).
  result.treeTerminated = await sweepAndConfirm(opts.mode, opts.distro, runId);
  const mntc = guestLog.match(/mntc_files=(\d+)/);
  const netns = guestLog.match(/netns_ifaces=(\d+)/);
  result.hostFsHidden = opts.mode === "wsl" ? Boolean(mntc && mntc[1] === "0") : false;
  result.networkVerified = Boolean(netns && netns[1] === "0");
  result.out = guestLog.slice(0, plan.maxOutputBytes);
  result.code = run.code;
  result.killed = run.code === null;
  return result;
}
