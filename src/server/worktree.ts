// Event Horizon Code — Worktree manager
// 1 task = 1 window = 1 git worktree. Pure git commands, no LSP spawn here.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Worktree = { id: string; path: string; branch: string };

function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: ((stdout as string) || (stderr as string) || "").trim() });
    });
  });
}

export async function listWorktrees(repoRoot: string): Promise<Worktree[]> {
  const r = await run("git", ["worktree", "list", "--porcelain"], repoRoot);
  if (!r.ok) return [];
  const out: Worktree[] = [];
  let cur: Partial<Worktree> = {};
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) { cur.path = line.slice(9); }
    else if (line.startsWith("branch ")) { cur.branch = line.slice(7).replace("refs/heads/", ""); }
    else if (line === "") {
      if (cur.path) out.push({ id: path.basename(cur.path), path: cur.path, branch: cur.branch ?? "main" });
      cur = {};
    }
  }
  return out;
}

export async function addWorktree(repoRoot: string, id: string, branch: string): Promise<{ ok: boolean; path: string; out: string }> {
  const target = path.join(repoRoot, ".eventhorizon", "worktrees", id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const r = await run("git", ["worktree", "add", "-b", branch, target], repoRoot);
  // If branch exists, fall back to existing checkout
  if (!r.ok && r.out.toLowerCase().includes("already exists")) {
    const r2 = await run("git", ["worktree", "add", target, branch], repoRoot);
    return { ok: r2.ok, path: target, out: r2.out };
  }
  return { ok: r.ok, path: target, out: r.out };
}

export async function removeWorktree(repoRoot: string, pathToRemove: string, force = false): Promise<{ ok: boolean; out: string }> {
  const args = ["worktree", "remove", ...(force ? ["-f"] : []), pathToRemove];
  const r = await run("git", args, repoRoot);
  return { ok: r.ok, out: r.out };
}
