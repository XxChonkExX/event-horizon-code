// Event Horizon Code - shared workspace containment
// ONE policy for every path that touches disk on behalf of the agent or the
// file browser (tools, HTTP file API, Electron fs IPC).
//
// Sweep-3 fix: the probe now uses lstat, so DANGLING symlinks are detected
// (existsSync follows links and would walk past them, approving a path whose
// writeFileSync would follow the dangling link outside the workspace).
// realpathSync rejects dangling links and resolves existing links/junctions.
//
// Stated limitation: validation and use are separate operations, so this is
// not a complete TOCTOU defence. Descriptor-relative operations remain the
// longer-term solution.

import fs from "node:fs";
import path from "node:path";

export type Containment = { ok: boolean; abs?: string; error?: string };

export function contained(worktree: string, requested: string): Containment {
  if (typeof requested !== "string" || requested.length === 0 || requested.length > 4096) {
    return { ok: false, error: "invalid path" };
  }
  if (path.isAbsolute(requested)) {
    return { ok: false, error: "absolute paths are not allowed - use a path relative to the workspace" };
  }

  try {
    const root = fs.realpathSync(path.resolve(worktree));
    const abs = path.resolve(root, requested);

    const lexicalRel = path.relative(root, abs);
    if (lexicalRel === ".." || lexicalRel.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRel)) {
      return { ok: false, error: "path escapes the workspace" };
    }

    // Find the deepest existing ancestor with lstat - which detects dangling
    // symbolic links that existsSync would silently skip.
    let probe = abs;
    for (;;) {
      try {
        fs.lstatSync(probe);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
          return { ok: false, error: "cannot safely inspect requested path" };
        }
        const parent = path.dirname(probe);
        if (parent === probe) return { ok: false, error: "no existing workspace ancestor" };
        probe = parent;
      }
    }

    // realpathSync resolves existing links/junctions and rejects dangling ones.
    const realProbe = fs.realpathSync(probe);
    const canonical = path.resolve(realProbe, path.relative(probe, abs));

    const canonicalRel = path.relative(root, canonical);
    if (canonicalRel === ".." || canonicalRel.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRel)) {
      return { ok: false, error: "path escapes the workspace through symlink" };
    }

    return { ok: true, abs: canonical };
  } catch {
    return { ok: false, error: "workspace containment validation failed" };
  }
}
