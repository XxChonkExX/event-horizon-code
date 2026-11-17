// Event Horizon Code — Tool registry (permission-gated)
// Built-in tools (read/edit/write/bash/grep/glob/ls/web/websearch/engram/
// verify/code_complete) plus MCP tools merged in by mcp.ts as mcp_<server>_<tool>.
// Permissions from .harness/config.json: allow / ask / deny per tool pattern.
// AgentWatch lineManager plugs here: gateDecision blocks edit/bash until reviewed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, exec } from "node:child_process";
import { readAgentWatchConfig, gateDecisionV2, sweepWorkspace } from "./agentwatch";
import { contained } from "./wsguard";

// AfterImage machines/src resolution - portable order, no machine-specific
// absolute paths: explicit env, sibling checkout, in-workspace copy.
function resolveEngramSrc(): string | null {
  const candidates = [
    process.env.EH_ENGRAM_SRC ?? "",
    path.join(process.cwd(), "..", "AfterImage-Engram", "src"),
    path.join(process.cwd(), "AfterImage-Engram", "src"),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const abs = path.resolve(c);
    if (fs.existsSync(path.join(abs, "machines.py"))) return abs;
  }
  return null;
}
import { searchEngram, verifyArithmetic, registerEngram } from "./engram";
import { listTodos, addTodo, toggleTodo, putInstruction } from "./store";
import crypto from "node:crypto";
import { audit } from "./audit";
import { engineEndpoint } from "./engine";
import { buildDetonatePlan, runDetonate, quarantineBaseline, quarantineDiff, scanUncleanScript, type DetonateTier } from "./detonate";
import { isMcpTool, callMcpTool } from "./mcp";

export type ToolName = "read" | "edit" | "write" | "bash" | "grep" | "glob" | "ls" | "websearch" | "webfetch" | "engram_search" | "engram_register" | "calc_verify" | "run_machine" | "run_js" | "todo" | "remember" | "verify" | "code_complete" | "screenshot";
export type ToolResult = { ok: boolean; out: string; error?: string; needsApproval?: boolean; image?: string };

function readConfig(): { permissions?: Record<string, string> } {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { permissions?: Record<string, string> };
  } catch { return { permissions: { read: "allow", edit: "ask", write: "ask", bash: "ask", grep: "allow", glob: "allow" } }; }
}

function permissionFor(tool: ToolName): string {
  const perms = readConfig().permissions ?? {};
  return perms[tool] ?? "ask";
}

function readDetonateConfig(): { enabled: boolean; timeoutMs?: number; maxOutputBytes?: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as {
      detonate?: { enabled?: boolean; policy?: { timeoutMs?: number; maxOutputBytes?: number } };
    };
    return {
      enabled: raw.detonate?.enabled === true,
      timeoutMs: raw.detonate?.policy?.timeoutMs,
      maxOutputBytes: raw.detonate?.policy?.maxOutputBytes,
    };
  } catch { return { enabled: false }; }
}

// External-binary resolution with caching. `python` is often not on PATH on
// Windows (it lives under %LOCALAPPDATA%\Programs\Python\...), and ripgrep/fd
// may be absent entirely — so we probe candidates once and fall back to
// pure-JS implementations for search rather than failing the tool.
const binCache = new Map<string, string | null>();
export function resolveBin(candidates: string[]): string | null {
  const key = candidates.join("|");
  if (binCache.has(key)) return binCache.get(key) ?? null;
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  for (const c of candidates) {
    if (!c) continue;
    try {
      execFileSync(c, ["--version"], { timeout: 4000, windowsHide: true, stdio: "ignore" });
      binCache.set(key, c);
      return c;
    } catch { /* try next */ }
  }
  // Last resort: common Windows Python install locations
  if (candidates.includes("python")) {
    const base = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Python");
    try {
      for (const d of fs.readdirSync(base)) {
        const exe = path.join(base, d, "python.exe");
        if (fs.existsSync(exe)) { binCache.set(key, exe); return exe; }
      }
    } catch { /* no python dir */ }
  }
  binCache.set(key, null);
  return null;
}

export const PYTHON_CANDIDATES = [process.env.EH_PYTHON ?? "", "python", "python3", "py"];

// Pure-JS workspace walk used when fd/rg are unavailable.
function walkFiles(root: string, maxFiles = 2000): string[] {
  const out: string[] = [];
  const stack = [root];
  const skip = new Set([".git", "node_modules", "out", "dist", ".eventhorizon"]);
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      // Sweep-3 #24: never follow symlinks - a link can point outside the
      // workspace (or at a credential file) and Dirent.isFile() is true for
      // file links.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

// Workspace jail: tools operate on paths relative to the workspace. Absolute
// paths and traversal are refused with a clear error (the model is told the
// constraint in its tool descriptions and can ask the user to relocate files).
// Credential files are refused outright: an agent (especially in automated
// mode) must never read or write BYOK keys or env files.
const CREDENTIAL_FILES = /(^|[\\/])(\.harness[\\/]secrets\.json|\.env(\..+)?|credentials?\.(json|ya?ml)|id_rsa|\.netrc)$/i;

function isCredentialPath(rel: string): boolean {
  const norm = rel.replace(/\\/g, "/").toLowerCase();
  // .example/.template/.sample files are templates, not secrets - always allowed.
  if (/\.(example|template|sample)$/.test(norm)) return false;
  if (norm.includes(".harness/secrets.json")) return true;
  // .env / .env.local / .env.production hold real values.
  if (/(^|\/)\.env(\..+)?$/.test(norm)) return true;
  return CREDENTIAL_FILES.test(norm);
}

// Exported for sweep-3 remediation: the ACP HTTP layer must enforce the SAME
// credential policy as the agent tools (one security rule, one implementation).
export function safePath(worktree: string, p: string): { ok: boolean; abs?: string; error?: string } {
  if (isCredentialPath(p)) {
    return { ok: false, error: "refused: credential files (.harness/secrets.json, .env) are never agent-readable or agent-writable. Ask the user to edit them by hand." };
  }
  // Shared containment policy (sibling-prefix proof + symlink canonicalisation).
  const result = contained(worktree, p);
  if (!result.ok || !result.abs) return result;
  // Sweep-3 #23: the canonical path can resolve INTO a credential file through
  // a symlink alias ("harmless-config.json" -> ".env") - re-check the resolved
  // path against the same policy.
  try {
    const rootReal = fs.realpathSync(path.resolve(worktree));
    const canonicalRel = path.relative(rootReal, result.abs);
    if (isCredentialPath(canonicalRel)) {
      return { ok: false, error: "resolved path targets a protected credential file" };
    }
  } catch { /* fall through to the containment result */ }
  return result;
}

async function agentWatchGate(tool: ToolName, worktree: string) {
  if (tool !== "edit" && tool !== "bash" && tool !== "write") return { allow: true, reason: "" };
  const cfg = readAgentWatchConfig();
  if (!cfg.enabled || !cfg.lineManager) return { allow: true, reason: "" };
  const sweep = await sweepWorkspace(worktree);
  const gate = gateDecisionV2(sweep);
  return gate;
}

// Detect the project's verification command. Priority: verify > test >
// typecheck > build, run through whichever package manager owns the lockfile.
function detectVerify(worktree: string): { cmd: string; label: string } | null {
  const has = (f: string) => fs.existsSync(path.join(worktree, f));
  if (has("package.json")) {
    let scripts: Record<string, string> = {};
    try { scripts = JSON.parse(fs.readFileSync(path.join(worktree, "package.json"), "utf8")).scripts ?? {}; } catch { /* unreadable */ }
    const pick = ["verify", "test", "typecheck", "build"].find((s) => typeof scripts[s] === "string" && (scripts[s] ?? "").trim());
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm";
    if (pick) {
      const cmd = pm === "pnpm" ? `pnpm run ${pick}` : pm === "yarn" ? `yarn ${pick}` : pm === "bun" ? `bun run ${pick}` : `npm run ${pick}`;
      return { cmd, label: `${pm} ${pick}` };
    }
  }
  if (has("Cargo.toml")) return { cmd: "cargo test", label: "cargo test" };
  if (has("go.mod")) return { cmd: "go test ./...", label: "go test" };
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    const py = resolveBin(PYTHON_CANDIDATES) ?? "python";
    return { cmd: `"${py}" -m pytest -q`, label: "pytest" };
  }
  return null;
}

function runVerify(cmd: string, worktree: string, timeoutMs = 180_000): Promise<ToolResult> {
  return new Promise((resolve) => {
    exec(cmd, { cwd: worktree, timeout: timeoutMs, maxBuffer: 800_000, windowsHide: true, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) => {
      const out = (String(stdout ?? "") + String(stderr ?? "")).slice(0, 60_000);
      resolve({ ok: !err, out, error: err ? String(err.message ?? err).slice(0, 200) : undefined });
    });
  });
}

export async function runTool(
  tool: ToolName,
  args: Record<string, unknown>,
  worktree = process.cwd(),
  opts?: { userApproved?: boolean; sessionId?: string }
): Promise<ToolResult> {
  const perm = permissionFor(tool);
  if (perm === "deny") {
    audit({ tool, note: "deny" });
    return { ok: false, error: `permission deny for ${tool}`, out: "" };
  }
  if (perm === "ask") {
    // Authorization NEVER comes from tool arguments: the model could emit
    // approved:true itself. Only the user channel (renderer HTTP call, editor
    // Save) or the session-level auto-approve opt-in may set it, via opts.
    const approved = opts?.userApproved === true;
    if (!approved) {
      audit({ tool, note: "ask-no-approval" });
      return { ok: false, needsApproval: true, out: `approval required for ${tool}. Approve from the Review pane and retry.`, error: "needs approval" };
    }
  }
  // The model cannot authorize its own tool calls - strip the flag entirely.
  delete (args as { approved?: boolean }).approved;
  // Sweep-3 #25: session identity is established by the application, not the
  // model - cross-session memory writes would be instruction injection.
  const sessionFor = opts?.sessionId ?? String(args.sessionId ?? "default");
  delete (args as { sessionId?: boolean }).sessionId;

  const gate = await agentWatchGate(tool, worktree);
  if (!gate.allow) {
    audit({ tool, note: "agentwatch-block" });
    return { ok: false, error: gate.reason, out: "", needsApproval: true };
  }

  try {
    // MCP tools (namespaced mcp_<server>_<tool>) execute through the MCP client.
    // Output is capped and audited like every other tool result.
    if (isMcpTool(tool)) {
      const r = await callMcpTool(tool, args);
      audit({ tool, note: `mcp ok=${r.ok}` });
      return { ok: r.ok, out: (r.out ?? "").slice(0, 20000), error: r.ok ? undefined : "mcp tool failed" };
    }
    if (tool === "read") {
      const sp = safePath(worktree, String(args.path ?? ""));
      if (!sp.ok) return { ok: false, error: sp.error, out: "" };
      const text = fs.readFileSync(sp.abs!, "utf8");
      audit({ tool, note: String(args.path ?? "") });
      return { ok: true, out: text.slice(0, 100000) };
    }
    if (tool === "edit") {
      const sp = safePath(worktree, String(args.path ?? ""));
      if (!sp.ok) return { ok: false, error: sp.error, out: "" };
      const oldText = fs.readFileSync(sp.abs!, "utf8");
      const newText = String(args.newText ?? "");
      audit({ tool, note: String(args.path ?? "") });
      fs.writeFileSync(sp.abs!, newText);
      return { ok: true, out: `Edited ${String(args.path ?? "")} (${oldText.length} -> ${newText.length} bytes)` };
    }
    if (tool === "write") {
      const sp = safePath(worktree, String(args.path ?? ""));
      if (!sp.ok) return { ok: false, error: sp.error, out: "" };
      fs.mkdirSync(path.dirname(sp.abs!), { recursive: true });
      fs.writeFileSync(sp.abs!, String(args.content ?? ""));
      audit({ tool, note: String(args.path ?? "") });
      return { ok: true, out: `Wrote ${String(args.path ?? "")}` };
    }
    if (tool === "bash") {
      const cmd = String(args.cmd ?? "");
      // Defense in depth: the file-tool jail blocks direct credential reads,
      // but a shell could still cat them. Refuse commands that name credential
      // files (.env.example is allowed - it is a template, not a secret).
      if (/\bsecrets\.json\b/i.test(cmd) || /(^|[^\w.])\.env(\.[^.]+)?\b/i.test(cmd.replace(/\.env\.example/g, "")) || /\bid_rsa\b|\.netrc\b|credentials?\.(json|ya?ml)\b/i.test(cmd)) {
        audit({ tool, note: "refused: credential file access" });
        return { ok: false, error: "refused: commands that read or write credential files (.harness/secrets.json, .env, keys) are not allowed. Ask the user instead.", out: "" };
      }
      const parsed = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((t) => t.replace(/^["']|["']$/g, "")) ?? [];
      if (parsed.length === 0) return { ok: false, error: "empty command", out: "" };
      // Optional allowlist from .harness/config.json (tools.bash.allowlist).
      // Absent = no allowlist beyond the permission gates - the user decides
      // policy, not a hardcoded list. When present, the FIRST token must match
      // (basename, case-insensitive, .exe stripped on Windows).
      {
        let allow: unknown;
        try {
          allow = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8"))?.tools?.bash?.allowlist;
        } catch { allow = undefined; }
        if (Array.isArray(allow) && allow.length > 0) {
          const bin = path.basename(parsed[0]).toLowerCase().replace(/\.exe$/i, "");
          const okBin = allow.some((entry) => {
            const e = String(entry).toLowerCase().replace(/\.exe$/i, "");
            return bin === e || (e.endsWith("*") && bin.startsWith(e.slice(0, -1)));
          });
          if (!okBin) {
            audit({ tool, note: `bash refused: ${bin} outside allowlist` });
            return { ok: false, error: `bash: executable "${parsed[0]}" is outside tools.bash.allowlist. Approve a broader policy in .harness/config.json or run it in the terminal.`, out: "" };
          }
        }
      }
      return new Promise<ToolResult>((resolve) => {
        execFile(parsed[0], parsed.slice(1), { cwd: worktree, timeout: 15000, maxBuffer: 200000, windowsHide: true }, (err, stdout, stderr) => {
          // Audit notes are privacy-sensitive: keep a short shape fingerprint,
          // never raw command text (commands can carry tokens/credentials).
          audit({ tool, note: `bash ${cmd.length}ch argv=${parsed.length - 1}` });
          resolve({ ok: !err, out: ((stdout as string) || "") + ((stderr as string) || ""), error: err ? String(err).slice(0, 200) : undefined });
        });
      });
    }
    if (tool === "grep") {
      const pattern = String(args.pattern ?? "");
      const where = String(args.path ?? ".");
      const rg = resolveBin(["rg"]);
      // The search root obeys the same containment policy as read/write.
      const whereGuard = safePath(worktree, where);
      if (!whereGuard.ok) return { ok: false, error: whereGuard.error, out: "" };
      const whereAbs = whereGuard.abs ?? path.resolve(worktree, where);
      if (rg) {
        return new Promise<ToolResult>((resolve) => {
          execFile(rg, ["-n", pattern, whereAbs], { cwd: worktree, timeout: 8000, windowsHide: true }, (err, stdout) => {
            resolve({ ok: !err, out: String(stdout).slice(0, 50000) });
          });
        });
      }
      // JS fallback: walk + regex line scan (no ripgrep required).
      try {
        const re = new RegExp(pattern, "i");
        const target = whereAbs;
        const files = fs.existsSync(target) && fs.statSync(target).isFile() ? [target] : walkFiles(fs.existsSync(target) ? target : worktree);
        const hits: string[] = [];
        for (const f of files) {
          let text = "";
          try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
          text.split("\n").forEach((line, i) => {
            if (hits.length < 200 && re.test(line)) hits.push(`${path.relative(worktree, f)}:${i + 1}:${line.trim().slice(0, 200)}`);
          });
        }
        audit({ tool, note: `js-fallback ${hits.length} hits` });
        return { ok: true, out: hits.join("\n") || "(no matches)" };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 200), out: "" };
      }
    }
    if (tool === "glob") {
      const pattern = String(args.pattern ?? "*");
      const fd = resolveBin(["fd"]);
      if (fd) {
        return new Promise<ToolResult>((resolve) => {
          execFile(fd, [pattern], { cwd: worktree, timeout: 8000, windowsHide: true }, (err, stdout) => {
            resolve({ ok: !err, out: String(stdout).slice(0, 50000) });
          });
        });
      }
      // JS fallback: convert the glob to a regex and walk the workspace.
      try {
        const rx = new RegExp(
          "^" + pattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*\//g, "(?:.*/)?")
            .replace(/\*\*/g, ".*")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, ".")
            + "$"
        );
        const rel = walkFiles(worktree).map((f) => path.relative(worktree, f).split(path.sep).join("/"));
        const hits = rel.filter((r) => rx.test(r)).slice(0, 500);
        audit({ tool, note: `js-fallback ${hits.length} files` });
        return { ok: true, out: hits.join("\n") || "(no matches)" };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 200), out: "" };
      }
    }
    if (tool === "ls") {
      // Jail: listing stays inside the workspace via the shared containment
      // guard (the old startsWith check accepted sibling-prefix directories).
      const dirGuard = safePath(worktree, String(args.path ?? "."));
      if (!dirGuard.ok) return { ok: false, error: dirGuard.error, out: "" };
      const dir = dirGuard.abs ?? path.resolve(worktree, String(args.path ?? "."));
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => !e.name.startsWith(".git"))
          .slice(0, 300)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        audit({ tool, note: path.relative(worktree, dir) || "." });
        return { ok: true, out: entries.join("\n") };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 200), out: "" };
      }
    }
    if (tool === "websearch") {
      // Keyless search: DuckDuckGo HTML endpoint, parsed to title+snippet+url.
      // Network-gated by the permission config; output treated as untrusted data.
      const q = String(args.query ?? "").trim();
      if (!q) return { ok: false, error: "query required", out: "" };
      const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "EventHorizonCode/0.1 (local coding agent)" },
        body: `q=${encodeURIComponent(q)}`,
        signal: AbortSignal.timeout(12000),
      });
      const html = await res.text();
      const results: string[] = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && results.length < 8) {
        const url = m[1].replace(/&amp;/g, "&");
        const title = m[2].replace(/<[^>]+>/g, "").trim();
        const snippet = (m[3] ?? "").replace(/<[^>]+>/g, "").trim();
        if (title) results.push(`${title}\n  ${url}\n  ${snippet.slice(0, 220)}`);
      }
      audit({ tool, note: `${q.slice(0, 60)} -> ${results.length} results` });
      return results.length
        ? { ok: true, out: results.join("\n\n") }
        : { ok: false, error: "no results parsed (network blocked or endpoint changed)", out: "" };
    }
    if (tool === "engram_search") {
      // AfterImage lookup (typed absence is a first-class answer). Import, never
      // reimplement — the subprocess calls afterimage_* directly.
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "query required", out: "" };
      const r = await searchEngram(query, Number(args.topK ?? 5));
      audit({ tool, note: `${query.slice(0, 50)} -> ${r.records.length}` });
      return r.absent
        ? { ok: true, out: `NO RECORDS for "${query}" (${r.coverage}) — do not guess; say it is unknown.` }
        : { ok: true, out: r.records.map((x, i) => `[${i + 1}] ${x}`).join("\n") };
    }
    if (tool === "engram_register") {
      // Append verbatim records to the AfterImage store (append-only by design).
      const raw = args.texts ?? args.text ?? [];
      const texts = (Array.isArray(raw) ? raw : [raw]).map(String).filter((t) => t.trim());
      if (!texts.length) return { ok: false, error: "text or texts[] required", out: "" };
      const r = await registerEngram(texts);
      audit({ tool, note: `registered ${r.n}` });
      return r.ok
        ? { ok: true, out: `Registered ${r.n} record(s) into the engram store. They are now retrievable via engram_search.` }
        : { ok: false, error: "engram store unavailable (python or AfterImage missing)", out: "" };
    }
    if (tool === "remember") {
      // Durable memory, two scopes:
      //  session (default) — keyed instruction, replays in the system prompt,
      //    survives compaction.
      //  project — appended to .harness/memory.md, shared across sessions and
      //    injected like AGENTS.md.
      const text = String(args.text ?? "").trim();
      if (!text) return { ok: false, error: "text required", out: "" };
      const scope = String(args.scope ?? "session");
      if (scope === "project") {
        // Memory writes obey the same containment policy as every other write,
        // and are size-capped (a model can be verbose; the file is shared).
        const memGuard = safePath(worktree, path.join(".harness", "memory.md"));
        if (!memGuard.ok) return { ok: false, error: memGuard.error, out: "" };
        const p = memGuard.abs ?? path.join(worktree, ".harness", "memory.md");
        const entry = text.slice(0, 2000);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (!fs.existsSync(p)) fs.writeFileSync(p, "# Project memory (written by the agent)\n\n");
        const existing = fs.readFileSync(p, "utf8").split("\n").map((l) => l.trim());
        if (existing.some((l) => l === `- ${entry}`)) {
          audit({ tool, note: "remember project duplicate" });
          return { ok: true, out: `Already in project memory (no duplicate written): ${entry}` };
        }
        fs.appendFileSync(p, `- ${entry}\n`);
        audit({ tool, note: "remember project" });
        return { ok: true, out: `Added to project memory (.harness/memory.md): ${text}` };
      }
      const key = String(args.key ?? `note-${Date.now().toString(36)}`);
      putInstruction(sessionFor, key, text);
      audit({ tool, note: `remember ${key}` });
      return { ok: true, out: `Remembered [${key}]: ${text}` };
    }
    if (tool === "calc_verify") {
      // Exact arithmetic (TI-85 AST whitelist) — verify before asserting numbers.
      const expr = String(args.expr ?? "").trim();
      if (!expr) return { ok: false, error: "expr required", out: "" };
      const r = await verifyArithmetic(expr);
      return r.ok ? { ok: true, out: `${expr} = ${r.value}` } : { ok: false, error: "calculator unavailable", out: "" };
    }
    if (tool === "run_machine") {
      // AfterImage engram machines (import, never reimplement): deterministic,
      // host-isolated interpreters. Called via the repo's own machines.run().
      const MACHINES = ["ti85", "pyvm", "rv32", "z80", "m6502", "thumb2", "dataflow"];
      const machine = String(args.machine ?? "");
      const code = String(args.code ?? "");
      if (!MACHINES.includes(machine)) return { ok: false, error: `unknown machine (one of ${MACHINES.join(", ")})`, out: "" };
      if (!code.trim()) return { ok: false, error: "code required", out: "" };
      const src = resolveEngramSrc();
      if (!src) {
        return { ok: false, error: "engram machines not found — set EH_ENGRAM_SRC to AfterImage-Engram/src", out: "" };
      }
      const driver = `import sys,json; sys.path.insert(0,r"${src}"); import machines; print(json.dumps(machines.run(sys.argv[1], sys.argv[2])))`;
      const py = resolveBin(PYTHON_CANDIDATES);
      if (!py) return { ok: false, error: "python not found — install Python or set EH_PYTHON to its path", out: "" };
      return new Promise<ToolResult>((resolve) => {
        execFile(py, ["-c", driver, machine, code], { timeout: 20000, windowsHide: true, maxBuffer: 200000 }, (err, stdout, stderr) => {
          if (err) { audit({ tool, note: `${machine} err` }); return resolve({ ok: false, error: String(err.message).slice(0, 200), out: "" }); }
          try {
            const r = JSON.parse(String(stdout).trim().split("\n").pop() || "{}") as { ok: boolean; result?: unknown; err?: string; steps?: number };
            audit({ tool, note: `${machine} ok=${r.ok}` });
            resolve({ ok: r.ok, out: JSON.stringify({ machine, result: r.result, steps: r.steps ?? 0, err: r.err ?? null }) });
          } catch {
            resolve({ ok: false, error: "machine output unparseable", out: "" });
          }
        });
      });
    }
    if (tool === "run_js") {
      // Programmatic tool calling: the clean tier is a DECLARATIVE read-only
      // batch (ops: read/ls/grep/glob, 1..16, no model-written code executes
      // in-process). tier=execute/redteam still accepts a code artifact and
      // routes to the detonation lane (microVM via sbx; refuses plainly when
      // sbx is unavailable - never a silent host fallback).
      const code = String(args.code ?? "").trim();
      const tier = String(args.tier ?? "review") as DetonateTier;
      const det = readDetonateConfig();
      if (tier !== "review" && !code) return { ok: false, error: "code required for the execute/redteam tiers", out: "" };

      if (tier !== "review") {
        if (!det.enabled) {
          audit({ tool, note: "detonate disabled in config" });
          return { ok: false, error: "the detonation lane is disabled (.harness/config.json detonate.enabled=false). Rewrite the script without host/network access, or enable the lane in config.", out: "" };
        }
        // Sweep-5: unpredictable name + exclusive creation - a predictable temp
        // path is a local pre-creation/overwrite race.
        const artifact = path.join(os.tmpdir(), `ehc-detonate-${crypto.randomUUID()}.mjs`);
        fs.writeFileSync(artifact, code, { flag: "wx" });
        const plan = buildDetonatePlan(worktree, tier, artifact);
        plan.timeoutMs = det.timeoutMs ?? plan.timeoutMs;
        plan.maxOutputBytes = det.maxOutputBytes ?? plan.maxOutputBytes;
        plan.artifactPath = artifact;
        audit({ tool, note: `detonate tier=${tier}` });
        let r: Awaited<ReturnType<typeof runDetonate>>;
        try {
          r = await runDetonate(plan);
        } finally {
          // Sweep-3 #19: artifact cleanup is unconditional - a runner throw
          // must not leave temporary scripts in the host temp directory.
          try { fs.rmSync(artifact, { force: true }); } catch { /* best effort */ }
        }
        if (r.missing) {
          return { ok: false, error: "the detonation lane needs sbx (microVM), which is not installed. Install sbx, or run with tier=review in the clean sandbox.", out: r.out };
        }
        // Sweep-5: capture the pre-execution status - detonation verification compares after vs before, so pre-existing dirty files cannot fake a pass or a fail.
        const baseline = quarantineBaseline(worktree);
        const q = quarantineDiff(worktree, baseline);
        const head = `detonation lane (${tier}) exit=${r.code}${r.killed ? " KILLED: timeout" : ""}` +
          (q.ok ? "" : ` | quarantine: host changed (${q.changed.slice(0, 3).join(", ")})`);
        // Sweep-3 #27: quarantine failure IS a failure - a "successful" run
        // that changed the host is exactly what the lane exists to catch.
        return {
          ok: !r.killed && r.code === 0 && q.ok,
          out: `${head}\n\n${r.out}`,
          error: r.killed ? "detonation timed out" : r.code !== 0 ? `exit code ${r.code}` : !q.ok ? "quarantine verification failed - the host workspace changed during detonation" : undefined,
        };
      }

      // Sweep-3 #17/18: the clean tier is a DECLARATIVE read-only batch. The
      // previous node:vm + host-stub design let model-generated JS run inside
      // the privileged server process: the static gate was bypassable via
      // dynamic property construction, host-created stub functions crossed the
      // realm boundary, and the vm timeout did not cover async continuations.
      // The batch preserves the tool's purpose (fewer round trips) with no
      // model-written code executing in-process. Arbitrary JS still exists via
      // tier=execute/redteam (detonation lane; refuses plainly without sbx).
      const opsRaw = (args as { ops?: unknown }).ops;
      if (!Array.isArray(opsRaw) || opsRaw.length === 0 || opsRaw.length > 16) {
        return {
          ok: false,
          error: 'run_js (clean tier) takes ops: 1..16 read-only operations, e.g. {"ops":[{"op":"glob","pattern":"*.ts"},{"op":"read","path":"src/index.ts"},{"op":"grep","pattern":"TODO","path":"src"}]}. ops: read | ls | grep | glob. For arbitrary code use tier="execute" (detonation lane, requires sbx).',
          out: "",
        };
      }
      const MAX_RESULT_BYTES = 100_000;
      const results: Array<{ op: string; ok: boolean; output: string }> = [];
      let totalBytes = 0;
      let opIndex = 0;
      for (const rawOp of opsRaw) {
        const o = (rawOp ?? {}) as { op?: string; path?: string; pattern?: string };
        let result: ToolResult;
        switch (o.op) {
          case "read": result = await runTool("read", { path: o.path ?? "" }, worktree, { userApproved: opts?.userApproved === true }); break;
          case "ls": result = await runTool("ls", { path: o.path ?? "." }, worktree, { userApproved: opts?.userApproved === true }); break;
          case "grep": result = await runTool("grep", { pattern: o.pattern ?? "", path: o.path ?? "." }, worktree, { userApproved: opts?.userApproved === true }); break;
          case "glob": result = await runTool("glob", { pattern: o.pattern ?? "" }, worktree, { userApproved: opts?.userApproved === true }); break;
          default:
            return { ok: false, error: `unsupported op "${String(o.op ?? "").slice(0, 40)}" at index ${opIndex} - allowed: read | ls | grep | glob`, out: "" };
        }
        opIndex++;
        const output = (result.ok ? result.out : (result.error ?? "operation failed")).slice(0, 20000);
        totalBytes += Buffer.byteLength(output, "utf8");
        if (totalBytes > MAX_RESULT_BYTES) {
          return { ok: false, error: "batch result limit exceeded (100 KB) - narrow the query", out: results.map((x) => `[${x.op}] ${x.output}`).join("\n").slice(0, 4000) };
        }
        results.push({ op: o.op ?? "?", ok: result.ok, output });
      }
      audit({ tool, note: `batch ops=${results.length} bytes=${totalBytes}` });
      const allOk = results.every((x) => x.ok);
      return { ok: allOk, out: results.map((x) => `[${x.op}${x.ok ? "" : " FAILED"}] ${x.output}`).join("\n---\n"), error: allOk ? undefined : "one or more batch operations failed" };
    }
    if (tool === "todo") {
      // Plan/progress tracking (OpenAI Agents SDK pattern). Stored per session.
      const op = String(args.op ?? "list");
      const sessionId = sessionFor;
      if (op === "add") {
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, error: "text required", out: "" };
        const t = addTodo({ id: `todo_${Date.now().toString(36)}`, sessionId, text, done: false });
        audit({ tool, note: `add ${t.id}` });
        return { ok: true, out: `Added: ${t.text}` };
      }
      if (op === "done") {
        const id = String(args.id ?? "");
        const all = listTodos(sessionId);
        const t = all.find((x) => x.id === id);
        if (t) { toggleTodo(id, true); return { ok: true, out: `Done: ${t.text}` }; }
        return { ok: false, error: `no todo ${id}`, out: "" };
      }
      const all = listTodos(sessionId);
      return { ok: true, out: all.length ? all.map((t) => `${t.done ? "[x]" : "[ ]"} ${t.id} — ${t.text}`).join("\n") : "(no todos)" };
    }
    if (tool === "webfetch") {
      // Fetch a URL as text, capped. Untrusted content — the agent is told to treat it as data.
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "http(s) url required", out: "" };
      const res = await fetch(url, { headers: { "user-agent": "EventHorizonCode/0.1 (local coding agent)" }, signal: AbortSignal.timeout(15000) });
      const text = await res.text();
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/\s{2,}/g, " ");
      audit({ tool, note: url.slice(0, 80) });
      return { ok: true, out: stripped.slice(0, 20000) };
    }
    if (tool === "code_complete") {
      // DeepSeek-Coder style FIM: fill the gap between a prefix and suffix.
      // Only meaningful when the bundled engine is running with a FIM model.
      const prefix = String(args.prefix ?? "");
      const suffix = String(args.suffix ?? "");
      if (!prefix && !suffix) return { ok: false, error: "prefix and/or suffix required", out: "" };
      const ep = engineEndpoint();
      if (!ep) return { ok: false, error: "engine not running - FIM completion needs the bundled engine (and ideally engine.spmInfill)", out: "" };
      try {
        const res = await fetch(ep.replace(/\/v1$/, "") + "/infill", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input_prefix: prefix, input_suffix: suffix, max_tokens: Number(args.maxTokens ?? 256), temperature: 0.2 }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) return { ok: false, error: `infill ${res.status}: ${(await res.text()).slice(0, 120)}`, out: "" };
        const j = (await res.json()) as { content?: string };
        audit({ tool, note: `prefix=${prefix.length} suffix=${suffix.length}` });
        return { ok: true, out: j.content ?? "" };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 200), out: "" };
      }
    }
    if (tool === "screenshot") {
      // Computer use, step 1: eyes on the primary screen. Windows-native via
      // System.Drawing (no deps). The PNG is returned as a data URL and attached
      // to the conversation, so a vision-capable model can actually see it -
      // capture without a vision model is stated as such, never pretended.
      if (process.platform !== "win32") return { ok: false, error: "screenshot is Windows-only right now (System.Drawing capture); macOS/Linux lanes are planned", out: "" };
      const dir = path.join(worktree, ".eventhorizon", "shots");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `shot-${Date.now().toString(36)}.png`);
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
        // DPI awareness: without this, a scaled desktop reports logical bounds
        // while CopyFromScreen captures physical pixels - a 150% display would
        // clip the capture to the top-left region.
        "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiFix { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }';",
        "[DpiFix]::SetProcessDPIAware() | Out-Null;",
        "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
        "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;",
        "$g = [System.Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size);",
        `$bmp.Save('${file.replace(/'/g, "''")}');`,
        "$g.Dispose(); $bmp.Dispose();",
      ].join("");
      const ok = await new Promise<boolean>((resolve) => {
        exec(`powershell.exe -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 20_000, windowsHide: true }, (err) => resolve(!err));
      });
      if (!ok || !fs.existsSync(file)) {
        return { ok: false, error: "capture failed - no interactive desktop session, or PowerShell refused. State that you cannot see the screen.", out: "" };
      }
      const b64 = fs.readFileSync(file).toString("base64");
      audit({ tool, note: `${Math.round(b64.length / 1024)} KB -> ${path.basename(file)}` });
      return {
        ok: true,
        out: `screenshot captured: ${path.basename(file)} (${Math.round(b64.length / 1024)} KB). Analyze the attached image.`,
        image: `data:image/png;base64,${b64}`,
      };
    }
    if (tool === "verify") {
      // Run the project's own checks. Detect the package manager and the best
      // available script so "verify" works across ecosystems without config.
      const v = detectVerify(worktree);
      if (!v) return { ok: false, error: "no recognisable project (looked for package.json, Cargo.toml, go.mod, pyproject.toml)", out: "" };
      const r = await runVerify(v.cmd, worktree);
      audit({ tool, note: `${v.label} ok=${r.ok}` });
      return {
        ok: r.ok,
        out: `${v.label} ${r.ok ? "PASSED" : "FAILED"}\n\n${r.out || "(no output)"}`,
        error: r.ok ? undefined : (r.error ?? "verify command failed"),
      };
    }
    return { ok: false, error: `unknown tool ${tool}`, out: "" };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200), out: "" };
  }
}
