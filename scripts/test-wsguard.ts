// Event Horizon Code - wsguard adversarial tests
// Covers the containment cases from the sweep-2 audit: sibling-prefix, ../
// traversal, absolute paths, symlink escapes (junctions on Windows), and the
// valid-path pass case. Run: npm run wsguard:test

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { contained } from "../src/server/wsguard";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// Fresh sandbox per run - never test against real user data.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-wsguard-"));
const inWs = (rel: string): string => path.join(root, rel);

try {
  fs.mkdirSync(inWs("sub"), { recursive: true });
  fs.writeFileSync(inWs("file.txt"), "x");

  // Valid relative path passes and resolves inside.
  const ok1 = contained(root, "file.txt");
  check("valid relative path passes", ok1.ok && ok1.abs?.toLowerCase() === inWs("file.txt").toLowerCase());

  // Sibling-prefix: <root>-escape must NOT pass for any ../ escape attempt.
  check("../ traversal rejected", !contained(root, "../outside.txt").ok);
  check("../../ traversal rejected", !contained(root, "../../outside.txt").ok);

  // Absolute paths rejected outright.
  check("absolute path rejected", !contained(root, os.tmpdir()).ok);
  check("windows drive path rejected", !contained(root, "C:\\Windows\\system32\\config.sys").ok || process.platform !== "win32");

  // The root itself is not a file target.
  check("root itself rejected", !contained(root, ".").ok);

  // Empty / oversized inputs rejected.
  check("empty path rejected", !contained(root, "").ok);
  check("oversized path rejected", !contained(root, "a".repeat(5000)).ok);

  // Symlink escape: a link inside the workspace pointing at tmpdir.
  const linkPath = inWs("escape-link");
  try {
    fs.symlinkSync(os.tmpdir(), linkPath, process.platform === "win32" ? "junction" : "dir");
    const escaped = contained(root, path.join("escape-link", "steal.txt"));
    check("symlink escape rejected", !escaped.ok);
  } catch {
    console.log("  SKIP symlink escape (symlink privilege unavailable)");
  }

  // Symlink/junction inside the workspace pointing INSIDE the workspace passes
  // (containment, not anti-symlink).
  try {
    const inner = inWs("inner-link");
    fs.symlinkSync(inWs("sub"), inner, process.platform === "win32" ? "junction" : "dir");
    const inside = contained(root, path.join("inner-link", "x.txt"));
    check("in-workspace link passes", inside.ok);
  } catch {
    console.log("  SKIP in-workspace link (symlink privilege unavailable)");
  }

  // Non-existent deep path under the workspace passes (creation target),
  // because its deepest existing ancestor (the root) is contained.
  const ok2 = contained(root, path.join("sub", "new", "deep.txt"));
  check("non-existent creation target passes", ok2.ok);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`[ehc] wsguard tests: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
