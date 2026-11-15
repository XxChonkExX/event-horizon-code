// SOP workflow engine tests: linear flow, human gates (approve / send-back /
// reject), the automated-mode preference, rework edges with the bounded loop,
// agent nodes without a model (plain failure), and cancellation.
// Run: npm run sop:test
//
// Uses a temp SOP dir (EH_SOPS_DIR) so the repo's own .harness/sops is untouched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// sopsDir() reads EH_SOPS_DIR at call time, so setting it before any startRun
// call is enough - no dynamic import needed.
import { startRun, approveRun, cancelRun, getRun, listSops } from "../src/server/sop";

process.env.EH_SOPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-sops-"));

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

function writeSop(sop: unknown): void {
  const sopObj = sop as { name: string };
  fs.writeFileSync(path.join(process.env.EH_SOPS_DIR!, `${sopObj.name}.json`), JSON.stringify(sop, null, 2));
}

function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timeout waiting for ${what}`)); }
    }, 25);
  });
}

const okScript = { id: "s1", type: "script", label: "Passing step", cmd: `node -e "console.log('step-ok')"` };
const okScript2 = { id: "s2", type: "script", label: "Second step", cmd: `node -e "console.log('step-two-ok')"` };
const badScript = { id: "bad", type: "script", label: "Failing step", cmd: `node -e "process.exit(3)"` };
const gate = { id: "g1", type: "gate", label: "Human review", note: "check the outputs" };

async function main(): Promise<void> {
  console.log("[ehc] sop workflow tests");

  // 1. gated flow: script -> gate (waits) -> approve -> done
  writeSop({ name: "gated-ok", nodes: [okScript, gate, okScript2] });
  const r1 = startRun("gated-ok", { worktree: process.cwd() });
  check("run starts", r1.ok === true && !!r1.run?.id, r1.error ?? "");
  const id1 = r1.run!.id;
  await until(() => getRun(id1)!.status === "waiting", 10000, "gate wait");
  check("gated run pauses at human gate", getRun(id1)!.status === "waiting" && getRun(id1)!.currentNode === "g1");
  const gateRec = getRun(id1)!.history.find((h) => h.status === "waiting");
  check("gate records what to review", !!gateRec && (gateRec.output ?? "").includes("check the outputs"));
  const a1 = approveRun(id1, { approved: true });
  await until(() => getRun(id1)!.status === "done", 10000, "completion after approval");
  check("approval completes the run", getRun(id1)!.status === "done");
  check("script outputs recorded", getRun(id1)!.history.some((h) => h.status === "ok" && h.output.includes("step-ok")));
  check("gate approval recorded", getRun(id1)!.history.some((h) => h.node === "g1" && h.status === "ok" && /approved/.test(h.output)));
  void a1;

  // 2. automated mode preference (per-run override): gate never pauses
  writeSop({ name: "auto-ok", mode: "gated", nodes: [okScript, { ...gate, id: "g1" }, okScript2] });
  const r2 = startRun("auto-ok", { worktree: process.cwd(), mode: "automated" });
  const id2 = r2.run!.id;
  await until(() => getRun(id2)!.status === "done", 10000, "automated completion");
  check("automated run completes without pausing", getRun(id2)!.status === "done");
  check("automated gate recorded as auto-approved", getRun(id2)!.history.some((h) => h.status === "skipped" && /auto-approved/.test(h.output)));
  check("run remembers its mode", getRun(id2)!.mode === "automated");

  // 3. SOP-file-level mode preference
  writeSop({ name: "file-auto", mode: "automated", nodes: [okScript, { ...gate, id: "g1" }] });
  const r3 = startRun("file-auto", { worktree: process.cwd() });
  const id3 = r3.run!.id;
  await until(() => getRun(id3)!.status === "done", 10000, "file-level automated completion");
  check("SOP file pins automated mode", getRun(id3)!.mode === "automated" && getRun(id3)!.status === "done");

  // 4. rework edge: failing step sends work back, and the loop is bounded
  writeSop({
    name: "rework-loop",
    mode: "automated",
    nodes: [
      { id: "prep", type: "script", cmd: `node -e "console.log('prep')"` },
      { ...badScript, onFail: "prep" },
    ],
  });
  const r4 = startRun("rework-loop", { worktree: process.cwd() });
  const id4 = r4.run!.id;
  await until(() => getRun(id4)!.status === "failed", 60000, "rework limit failure");
  check("rework loop is bounded and fails plainly", /rework limit/.test(getRun(id4)!.error ?? ""), getRun(id4)!.error ?? "");
  const failCount = getRun(id4)!.history.filter((h) => h.status === "fail").length;
  check("failing step re-ran via onFail edge", failCount >= 2, `${failCount} failures recorded`);

  // 5. single failure with no onFail fails the run with the node's output
  writeSop({ name: "plain-fail", mode: "automated", nodes: [badScript] });
  const r5 = startRun("plain-fail", { worktree: process.cwd() });
  const id5 = r5.run!.id;
  await until(() => getRun(id5)!.status === "failed", 30000, "plain failure");
  check("unhandled script failure fails the run", getRun(id5)!.status === "failed" && /Failing step/.test(getRun(id5)!.error ?? ""), getRun(id5)!.error ?? "");

  // 6. send back to a chosen step from a gate (LoopForge acceptance flow)
  writeSop({ name: "send-back", nodes: [gate, okScript] });
  const r6 = startRun("send-back", { worktree: process.cwd() });
  const id6 = r6.run!.id;
  await until(() => getRun(id6)!.status === "waiting", 10000, "gate wait (send-back)");
  approveRun(id6, { approved: false, sendBackTo: "s1" });
  await until(() => getRun(id6)!.status === "done", 10000, "completion after send-back");
  check("send-back reruns the target step and completes", getRun(id6)!.status === "done");
  check("send-back decision recorded", getRun(id6)!.history.some((h) => h.node === "g1" && /sent back/.test(h.output)));

  // 7. reject with no send-back target fails the run
  writeSop({ name: "reject", nodes: [gate, okScript] });
  const r7 = startRun("reject", { worktree: process.cwd() });
  const id7 = r7.run!.id;
  await until(() => getRun(id7)!.status === "waiting", 10000, "gate wait (reject)");
  approveRun(id7, { approved: false });
  check("rejection fails the run with the reason", getRun(id7)!.status === "failed" && /rejected at gate/.test(getRun(id7)!.error ?? ""), getRun(id7)!.error ?? "");

  // 8. agent node with no model available: plain failure, never a fake pass
  writeSop({ name: "no-model", mode: "automated", nodes: [{ id: "a1", type: "agent", label: "Think step", prompt: "say READY" }] });
  const r8 = startRun("no-model", { worktree: process.cwd() });
  const id8 = r8.run!.id;
  await until(() => getRun(id8)!.status === "failed", 30000, "agent node failure");
  check("agent node without a model fails plainly", getRun(id8)!.status === "failed", getRun(id8)!.error ?? "");

  // 9. cancellation stops a running run
  writeSop({ name: "cancel-me", mode: "automated", nodes: [{ id: "slow", type: "script", cmd: `node -e "setTimeout(()=>{},5000)"` }, okScript] });
  const r9 = startRun("cancel-me", { worktree: process.cwd() });
  const id9 = r9.run!.id;
  cancelRun(id9);
  await until(() => getRun(id9)!.status === "cancelled", 15000, "cancellation");
  check("cancel stops the run", getRun(id9)!.status === "cancelled");

  // 10. listing + unknown SOP errors
  check("listSops sees the fixtures", listSops().length >= 9);
  check("unknown SOP refused", startRun("nope", { worktree: process.cwd() }).ok === false);

  // 11. the run's task reaches agent nodes (LoopForge: runs link to requirements)
  fs.writeFileSync(path.join(process.env.EH_SOPS_DIR!, "tasked.json"), JSON.stringify({
    name: "tasked", mode: "automated",
    nodes: [{ id: "echo-task", type: "script", cmd: `node -e "console.log('task check')"`, }],
  }), "utf8");
  // (task injection is verified against a run record: the task is stored verbatim)
  const r11 = startRun("tasked", { worktree: process.cwd(), task: "Fix the flaky login test" });
  const id11 = r11.run!.id;
  await until(() => getRun(id11)!.status === "done", 30000, "tasked completion");
  check("run records the task", getRun(id11)!.task === "Fix the flaky login test", getRun(id11)!.task ?? "(none)");
  const persisted = JSON.parse(fs.readFileSync(path.join(process.env.EH_SOPS_DIR!, "runs", `${id11}.json`), "utf8")) as { task?: string };
  check("task persisted with the run record", persisted.task === "Fix the flaky login test");

  console.log(failures === 0 ? "[ehc] sop workflow tests: ALL PASS" : `[ehc] sop workflow tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] sop tests crashed:", e); process.exit(1); });
