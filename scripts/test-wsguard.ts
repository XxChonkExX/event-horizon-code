// Event Horizon Code - wsguard adversarial tests
// Covers the containment cases from the sweep-2 audit: sibling-prefix, ../
// traversal, absolute paths, symlink escapes (junctions on Windows), and the
// valid-path pass case. Run: npm run wsguard:test

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { contained } from "../src/server/wsguard";
import { safePath } from "../src/server/tools";

let cpass = 0;
let cfail = 0;
function checkCred(name: string, cond: boolean): void {
  if (cond) { cpass++; console.log(`  PASS ${name}`); }
  else { cfail++; console.log(`  FAIL ${name}`); }
}

// Credential policy (safePath = containment + credential refusal in one rule).
try {
  const credRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-cred-"));
  fs.mkdirSync(path.join(credRoot, ".harness"), { recursive: true });
  checkCred(".env refused", !safePath(credRoot, ".env").ok);
  checkCred(".env.local refused", !safePath(credRoot, ".env.local").ok);
  checkCred(".env.production refused", !safePath(credRoot, ".env.production").ok);
  checkCred(".harness/secrets.json refused", !safePath(credRoot, path.join(".harness", "secrets.json")).ok);
  checkCred(".env.example permitted", safePath(credRoot, ".env.example").ok);
  checkCred("normal file permitted", safePath(credRoot, "src/index.ts").ok);
  checkCred("parent traversal refused", !safePath(credRoot, "../outside.txt").ok);
  // EH_SECRETS_FILE can put the BYOK secrets file anywhere under any name.
  // The name patterns only know `.harness/secrets.json`, so the resolved
  // location has to be protected too - and ONLY it (no collateral refusals).
  const savedSecretsFile = process.env.EH_SECRETS_FILE;
  try {
    fs.mkdirSync(path.join(credRoot, "config"), { recursive: true });
    const moved = path.join(credRoot, "config", "keys.json");
    process.env.EH_SECRETS_FILE = moved;
    fs.writeFileSync(moved, "{}");
    const refused = safePath(credRoot, path.join("config", "keys.json"));
    if (refused.ok) console.log(`    (was allowed: ${refused.abs})`);
    checkCred("relocated secrets file (EH_SECRETS_FILE) refused", !refused.ok && /secrets file/i.test(refused.error ?? ""));
    fs.rmSync(moved);
    checkCred("relocated secrets file refused before it exists (write target)", !safePath(credRoot, path.join("config", "keys.json")).ok);
    checkCred("its atomic temp file refused", !safePath(credRoot, path.join("config", "keys.json.tmp-1-abc")).ok);
    checkCred("similarly named neighbour still permitted", safePath(credRoot, path.join("config", "keys.json.bak")).ok);
    checkCred("other files still permitted", safePath(credRoot, path.join("config", "settings.json")).ok);
    fs.writeFileSync(moved, "{}");
    try {
      fs.symlinkSync(moved, path.join(credRoot, "alias.json"));
      checkCred("relocated secrets file refused through a symlink alias", !safePath(credRoot, "alias.json").ok);
      fs.rmSync(path.join(credRoot, "alias.json"));
    } catch { console.log("  SKIP symlink alias for the relocated secrets file (cannot create symlinks here)"); }
    delete process.env.EH_SECRETS_FILE;
    checkCred("with no override the same name is an ordinary file", safePath(credRoot, path.join("config", "keys.json")).ok);
    process.env.EH_SECRETS_FILE = "";
    checkCred("an EMPTY override means not set (workspace root and the old name are ordinary paths)", safePath(credRoot, ".").ok && safePath(credRoot, path.join("config", "keys.json")).ok);
  } catch (e) {
    console.log(`  FAIL relocated-secrets suite: ${String(e).slice(0, 160)}`);
    cfail++;
  } finally {
    if (savedSecretsFile === undefined) delete process.env.EH_SECRETS_FILE; else process.env.EH_SECRETS_FILE = savedSecretsFile;
  }
  fs.rmSync(credRoot, { recursive: true, force: true });
} catch (e) {
  console.log(`  FAIL credential suite setup: ${String(e).slice(0, 120)}`);
  cfail++;
}

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

  // Valid relative path passes and resolves inside. The comparison uses the
  // real root: on macOS os.tmpdir() sits under /var, a symlink to /private/var,
  // so contained() answers with the canonical (real) path - the non-canonical
  // join would compare /var/... against /private/var/... and fail (found by
  // the macOS CI run, 2026-11-27).
  const ok1 = contained(root, "file.txt");
  const realRoot = fs.realpathSync(root);
  const inWsReal = (rel: string): string => path.join(realRoot, rel);
  check("valid relative path passes", ok1.ok && ok1.abs?.toLowerCase() === inWsReal("file.txt").toLowerCase());

  // Sibling-prefix: <root>-escape must NOT pass for any ../ escape attempt.
  check("../ traversal rejected", !contained(root, "../outside.txt").ok);
  check("../../ traversal rejected", !contained(root, "../../outside.txt").ok);

  // Absolute paths rejected outright.
  check("absolute path rejected", !contained(root, os.tmpdir()).ok);
  check("windows drive path rejected", !contained(root, "C:\\Windows\\system32\\config.sys").ok || process.platform !== "win32");

  // The root itself is not a file target.
  check("root itself is contained (deletion is refused by the fs:op caller)", contained(root, ".").ok);

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

  // Sweep-3 #22: dangling symlink - existsSync follows links and would skip
  // it; lstat must catch the link itself and reject the escape.
  try {
    const dangling = inWs("dangling-link");
    fs.symlinkSync(path.join(os.tmpdir(), "ehc-nonexistent-target"), dangling, process.platform === "win32" ? "file" : "file");
    check("dangling symlink rejected", !contained(root, "dangling-link").ok);
    check("dangling symlink child rejected", !contained(root, path.join("dangling-link", "write.txt")).ok);
  } catch {
    console.log("  SKIP dangling symlink test (symlink privilege unavailable)");
  }

  // Sweep-3 #23: a symlink alias that resolves INTO a credential file must be
  // refused by the credential policy even though the requested name is benign.
  try {
    const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-cred-alias-"));
    fs.mkdirSync(path.join(aliasRoot, ".harness"), { recursive: true });
    fs.writeFileSync(path.join(aliasRoot, ".harness", "secrets.json"), "{}");
    fs.symlinkSync(path.join(aliasRoot, ".harness", "secrets.json"), path.join(aliasRoot, "harmless-config.json"));
    const viaAlias = safePath(aliasRoot, "harmless-config.json");
    check("symlink alias into credential file refused", !viaAlias.ok);
    fs.rmSync(aliasRoot, { recursive: true, force: true });
  } catch {
    console.log("  SKIP credential alias test (symlink privilege unavailable)");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`[ehc] wsguard tests: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
