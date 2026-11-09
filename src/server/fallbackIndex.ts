// Event Horizon Code — fallback symbol index
// Used when no LSP is available. Prefers universal-ctags, else regex.
// Pure functions, stdlib only. No GPU, no embeddings.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type Symbol = { name: string; file: string; line: number; kind: string };

function hasCtags(): boolean {
  try {
    execFileSync("ctags", ["--version"], { timeout: 2000, stdio: "ignore" });
    return true;
  } catch { return false; }
}

export function indexSymbols(worktree: string, fileExt: string): Symbol[] {
  if (hasCtags()) {
    try {
      const out = execFileSync(
        "ctags",
        ["-R", "--output-format=json", `--languages=${fileExt}`, "."],
        { cwd: worktree, timeout: 8000, encoding: "utf8" }
      );
      return out.split("\n").filter(Boolean).slice(0, 500).map((line) => {
        const j = JSON.parse(line) as { name: string; path: string; line: number; kind: string };
        return { name: j.name, file: path.join(worktree, j.path), line: j.line, kind: j.kind };
      });
    } catch { return []; }
  }
  return regexSymbols(worktree, fileExt);
}

// Lightweight regex fallback — covers function/class/def/pub fn patterns for majors.
// Not a parser. Exists to keep "go to symbol" useful with zero deps.
export function regexSymbols(worktree: string, fileExt: string): Symbol[] {
  const patterns: Record<string, RegExp> = {
    py: /^\s*(?:async\s+)?def\s+(\w+)/,
    rs: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
    go: /^func\s+(\w+)/,
    js: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    ts: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    class: /^\s*(?:pub\s+|export\s+|abstract\s+)*(?:class|struct|enum)\s+(\w+)/,
  };
  const re = patterns[fileExt.replace(".", "")] ?? patterns.class;
  const out: Symbol[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git" || e === "target") continue;
      const full = path.join(dir, e);
      let st: fs.Stats;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { walk(full); continue; }
      if (!full.endsWith(fileExt)) continue;
      let text = "";
      try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      text.split("\n").forEach((line, i) => {
        const m = line.match(re);
        if (m) out.push({ name: m[1], file: full, line: i + 1, kind: "symbol" });
      });
      if (out.length >= 500) return;
    }
  };
  walk(worktree);
  return out;
}
