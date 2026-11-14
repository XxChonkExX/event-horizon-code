// Event Horizon Code — Tool registry (MCP-compatible, permission-gated)
// Tools: read, edit, write, bash, grep, glob. MCP client stub for external tools.
// Permissions from .harness/config.json: allow / ask / deny per tool pattern.
// AgentWatch lineManager plugs here: gateDecision blocks edit/bash until reviewed.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { readAgentWatchConfig, gateDecisionV2, sweepWorkspace } from "./agentwatch";
import { searchEngram, verifyArithmetic } from "./engram";
import { listTodos, addTodo, toggleTodo } from "./store";
import vm from "node:vm";
import { audit } from "./audit";

export type ToolName = "read" | "edit" | "write" | "bash" | "grep" | "glob" | "ls" | "websearch" | "webfetch" | "engram_search" | "calc_verify" | "run_machine" | "run_js" | "todo";
export type ToolResult = { ok: boolean; out: string; error?: string; needsApproval?: boolean };

function readConfig(): { permissions?: Record<string, string> } {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { permissions?: Record<string, string> };
  } catch { return { permissions: { read: "allow", edit: "ask", write: "ask", bash: "ask", grep: "allow", glob: "allow" } }; }
}

function permissionFor(tool: ToolName): string {
  const perms = readConfig().permissions ?? {};
  return perms[tool] ?? "ask";
}

// Workspace jail: tools operate on paths relative to the workspace. Absolute
// paths and traversal are refused with a clear error (the model is told the
// constraint in its tool descriptions and can ask the user to relocate files).
function safePath(worktree: string, p: string): { ok: boolean; abs?: string; error?: string } {
  if (path.isAbsolute(p)) {
    return { ok: false, error: "absolute paths are not allowed — use a path relative to the workspace, or ask the user to move the file into the workspace" };
  }
  const abs = path.resolve(worktree, p);
  const root = path.resolve(worktree);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, error: "path escapes the workspace" };
  }
  return { ok: true, abs };
}

async function agentWatchGate(tool: ToolName, worktree: string) {
  if (tool !== "edit" && tool !== "bash" && tool !== "write") return { allow: true, reason: "" };
  const cfg = readAgentWatchConfig();
  if (!cfg.enabled || !cfg.lineManager) return { allow: true, reason: "" };
  const sweep = await sweepWorkspace(worktree);
  const gate = gateDecisionV2(sweep);
  return gate;
}

export async function runTool(tool: ToolName, args: Record<string, unknown>, worktree = process.cwd()): Promise<ToolResult> {
  const perm = permissionFor(tool);
  if (perm === "deny") {
    audit({ tool, note: "deny" });
    return { ok: false, error: `permission deny for ${tool}`, out: "" };
  }
  if (perm === "ask") {
    // In headless/test mode we require explicit approval flag. Frontend approval UI sets approved=true.
    const approved = (args as { approved?: boolean }).approved === true;
    if (!approved) {
      audit({ tool, note: "ask-no-approval" });
      return { ok: false, needsApproval: true, out: `approval required for ${tool}. Pass approved=true after user Review.`, error: "needs approval" };
    }
  }

  const gate = await agentWatchGate(tool, worktree);
  if (!gate.allow) {
    audit({ tool, note: "agentwatch-block" });
    return { ok: false, error: gate.reason, out: "", needsApproval: true };
  }

  try {
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
      const parsed = cmd.trim().split(/\s+/);
      return new Promise<ToolResult>((resolve) => {
        execFile(parsed[0], parsed.slice(1), { cwd: worktree, timeout: 15000, maxBuffer: 200000, windowsHide: true }, (err, stdout, stderr) => {
          audit({ tool, note: cmd.slice(0, 80) });
          resolve({ ok: !err, out: ((stdout as string) || "") + ((stderr as string) || ""), error: err ? String(err).slice(0, 200) : undefined });
        });
      });
    }
    if (tool === "grep") {
      return new Promise<ToolResult>((resolve) => {
        execFile("rg", ["-n", String(args.pattern ?? ""), String(args.path ?? ".")], { cwd: worktree, timeout: 8000, windowsHide: true }, (err, stdout) => {
          resolve({ ok: !err, out: String(stdout).slice(0, 50000) });
        });
      });
    }
    if (tool === "glob") {
      return new Promise<ToolResult>((resolve) => {
        execFile("fd", [String(args.pattern ?? ".")], { cwd: worktree, timeout: 8000, windowsHide: true }, (err, stdout) => {
          resolve({ ok: !err, out: String(stdout).slice(0, 50000) });
        });
      });
    }
    if (tool === "ls") {
      const dir = path.resolve(worktree, String(args.path ?? "."));
      // Jail: listing stays inside the workspace (read-only, no traversal).
      if (!dir.startsWith(path.resolve(worktree))) return { ok: false, error: "path outside workspace", out: "" };
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
      const src = process.env.EH_ENGRAM_SRC ?? "C:/Users/mikeh/Documents/New OpenCode Project/AfterImage-Engram/src";
      if (!fs.existsSync(path.join(src, "machines.py"))) {
        return { ok: false, error: "engram machines not found — set EH_ENGRAM_SRC to AfterImage-Engram/src", out: "" };
      }
      const driver = `import sys,json; sys.path.insert(0,r"${src}"); import machines; print(json.dumps(machines.run(sys.argv[1], sys.argv[2])))`;
      return new Promise<ToolResult>((resolve) => {
        execFile(process.env.PYTHON ?? "python", ["-c", driver, machine, code], { timeout: 20000, windowsHide: true, maxBuffer: 200000 }, (err, stdout, stderr) => {
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
      // Programmatic tool calling (Anthropic PTC pattern): the model writes one
      // program that batches read-only tools instead of one round trip per call.
      // Light sandbox (node:vm): no require, no fs, no net, no timers — only the
      // injected stubs. Output capped. Untrusted scripts should use the detonate lane.
      const code = String(args.code ?? "").trim();
      if (!code) return { ok: false, error: "code required", out: "" };
      const stubCalls = { n: 0 };
      const MAX_CALLS = 16;
      const stub = (name: string) => async (a: Record<string, unknown>) => {
        if (++stubCalls.n > MAX_CALLS) throw new Error(`stub call cap (${MAX_CALLS}) exceeded`);
        const r = await runTool(name as ToolName, a, worktree);
        return JSON.stringify({ ok: r.ok, out: (r.ok ? r.out : (r.error ?? "")).slice(0, 20000) });
      };
      const sandbox: Record<string, unknown> = {
        read: stub("read"), ls: stub("ls"), grep: stub("grep"), glob: stub("glob"),
        console: { log: (...a: unknown[]) => { captured.push(a.map(String).join(" ")); } },
      };
      const captured: string[] = [];
      try {
        const ctx = vm.createContext(sandbox);
        const script = `(async () => {\n${code}\n})()`;
        const result = await vm.runInContext(script, ctx, { timeout: 10000 });
        const out = [
          captured.length ? `[log]\n${captured.join("\n").slice(0, 2000)}` : "",
          result !== undefined ? `[return]\n${String(result).slice(0, 20000)}` : "",
          `[stub calls: ${stubCalls.n}]`,
        ].filter(Boolean).join("\n");
        audit({ tool, note: `calls=${stubCalls.n} out=${out.length}` });
        return { ok: true, out };
      } catch (e) {
        return { ok: false, error: `sandbox: ${String(e).slice(0, 200)}`, out: captured.join("\n").slice(0, 2000) };
      }
    }
    if (tool === "todo") {
      // Plan/progress tracking (OpenAI Agents SDK pattern). Stored per session.
      const op = String(args.op ?? "list");
      const sessionId = String(args.sessionId ?? "default");
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
    return { ok: false, error: `unknown tool ${tool}`, out: "" };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200), out: "" };
  }
}
