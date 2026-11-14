// Event Horizon Code — Tool registry (MCP-compatible, permission-gated)
// Tools: read, edit, write, bash, grep, glob. MCP client stub for external tools.
// Permissions from .harness/config.json: allow / ask / deny per tool pattern.
// AgentWatch lineManager plugs here: gateDecision blocks edit/bash until reviewed.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { readAgentWatchConfig, gateDecisionV2, sweepWorkspace } from "./agentwatch";
import { audit } from "./audit";

export type ToolName = "read" | "edit" | "write" | "bash" | "grep" | "glob" | "ls" | "websearch" | "webfetch";
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
      const file = path.join(worktree, String(args.path ?? ""));
      const text = fs.readFileSync(file, "utf8");
      audit({ tool, note: String(args.path ?? "") });
      return { ok: true, out: text.slice(0, 100000) };
    }
    if (tool === "edit") {
      const file = path.join(worktree, String(args.path ?? ""));
      const oldText = fs.readFileSync(file, "utf8");
      const newText = String(args.newText ?? "");
      audit({ tool, note: String(args.path ?? "") });
      // Diff preview is caller's job; here we write atomically.
      fs.writeFileSync(file, newText);
      return { ok: true, out: `Edited ${String(args.path ?? "")} (${oldText.length} -> ${newText.length} bytes)` };
    }
    if (tool === "write") {
      const file = path.join(worktree, String(args.path ?? ""));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(args.content ?? ""));
      audit({ tool, note: String(args.path ?? "") });
      return { ok: true, out: `Wrote ${file}` };
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
