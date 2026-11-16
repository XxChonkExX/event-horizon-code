// Event Horizon Code - shared workspace containment
// ONE policy for every path that touches disk on behalf of the agent or the
// file browser (tools, HTTP file API, Electron fs IPC). Lexical containment
// via path.relative (sibling-prefix proof), then canonicalisation through
// realpath for anything that exists on disk, so a symlink or Windows junction
// cannot silently retarget outside the workspace.
//
// Stated limitation: validation and use are separate operations, so this is
// not a complete TOCTOU defence. Mutating tools additionally resolve through
// this guard at execution time.

import fs from "node:fs";
import path from "node:path";

export type Containment = { ok: boolean; abs?: string; error?: string };

export function contained(worktree: string, p: string): Containment {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) {
    return { ok: false, error: "invalid path" };
  }
  if (path.isAbsolute(p)) {
    return { ok: false, error: "absolute paths are not allowed - use a path relative to the workspace" };
  }
  const root = path.resolve(worktree);
  const abs = path.resolve(root, p);
  // Separator-aware containment: rejects sibling prefixes like <root>-escape.
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "path escapes the workspace" };
  }
  // Canonical check for whatever already exists on disk: the deepest existing
  // ancestor is resolved through realpath, so symlink/junction retargets fail.
  try {
    let probe = abs;
    for (;;) {
      if (fs.existsSync(probe)) break;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (fs.existsSync(probe)) {
      const realProbe = fs.realpathSync(probe);
      const canonical = realProbe === probe ? abs : path.join(realProbe, path.relative(probe, abs));
      const rootReal = fs.realpathSync(root);
      const relC = path.relative(rootReal, canonical);
      if (relC === "" || relC.startsWith("..") || path.isAbsolute(relC)) {
        return { ok: false, error: "path escapes the workspace (symlink)" };
      }
      return { ok: true, abs: canonical };
    }
  } catch { /* realpath unavailable - lexical containment already applied */ }
  return { ok: true, abs };
}
