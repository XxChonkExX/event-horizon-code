// Event Horizon Code — Tool registry (MCP-compatible, permission-gated)
// Tools: read, edit, write, bash, grep, glob. MCP client stub for external tools.
// Permissions from .harness/config.json: allow / ask / deny per tool pattern.
// AgentWatch lineManager plugs here: gateDecision blocks edit/bash until reviewed.

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { readAgentWatchConfig, gateDecision, sweepWorkspace } from "./agentwatch";
import { audit } from "./audit";

export type ToolName = "read" | "edit" | "write" | "bash" | "grep" | "glob";
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
  const gate = gateDecision(sweep);
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
        execFile(parsed[0], parsed.slice(1), { cwd: worktree, timeout: 15000, maxBuffer: 200000 }, (err, stdout, stderr) => {
          audit({ tool, note: cmd.slice(0, 80) });
          resolve({ ok: !err, out: ((stdout as string) || "") + ((stderr as string) || ""), error: err ? String(err).slice(0, 200) : undefined });
        });
      });
    }
    if (tool === "grep") {
      return new Promise<ToolResult>((resolve) => {
        execFile("rg", ["-n", String(args.pattern ?? ""), String(args.path ?? ".")], { cwd: worktree, timeout: 8000 }, (err, stdout) => {
          resolve({ ok: !err, out: String(stdout).slice(0, 50000) });
        });
      });
    }
    if (tool === "glob") {
      return new Promise<ToolResult>((resolve) => {
        execFile("fd", [String(args.pattern ?? ".")], { cwd: worktree, timeout: 8000 }, (err, stdout) => {
          resolve({ ok: !err, out: String(stdout).slice(0, 50000) });
        });
      });
    }
    return { ok: false, error: `unknown tool ${tool}`, out: "" };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200), out: "" };
  }
}
