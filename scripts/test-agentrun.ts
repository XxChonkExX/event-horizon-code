// Durable Agent Run tests (Phase 1): state machine transitions, timeline
// persistence across reopen, boot recovery (interrupted runs), and the agent
// loop integration (no-model turn fails the run honestly). Run: npm run runs:test
//
// Uses a temp database via EH_DB (like test-sessions) - never operator data.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initStore, closeStore, getAgentRun, listAgentRuns, listRunEvents } from "../src/server/store";
import { beginRun, transition, completeRun, failRun, cancelRun, runTimeline, markStaleRunsInterrupted, canTransition } from "../src/server/agentrun";
import { runAgentTurn } from "../src/server/agentLoop";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log("[ehc] durable agent run tests");
  process.env.EH_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ehc-runs-")), "data.db");
  const { mode } = initStore();
  check("store opened as sqlite", mode === "sqlite", mode);

  // 1. create + read back
  const run = beginRun({ sessionId: "ses_test", objective: "Fix the flaky test", workdir: process.cwd() });
  const got = getAgentRun(run.id);
  check("run created and readable", Boolean(got && got.id === run.id && got.state === "queued"), JSON.stringify(got)?.slice(0, 120));
  check("objective recorded", got?.objective === "Fix the flaky test");

  // 2. transitions + ordered timeline
  check("queued->running ok", transition(run.id, "running").ok);
  check("running->awaiting_approval ok", transition(run.id, "awaiting_approval", "edit needs approval").ok);
  check("awaiting_approval->running ok", transition(run.id, "running").ok);
  check("running->verifying ok", transition(run.id, "verifying").ok);
  check("verifying->completed ok", completeRun(run.id, "test fixed").ok);
  const tl = runTimeline(run.id);
  const stateChanges = tl.events.filter((e) => e.kind === "state.change");
  check("timeline ordered: created first", tl.events[0]?.kind === "run.created");
  check("five state changes recorded", stateChanges.length === 5, `${stateChanges.length}`);
  check("terminal event present", tl.events.some((e) => e.kind === "run.completed"));

  // 3. invalid transitions refused, terminal is terminal
  check("completed refuses further transitions", !transition(run.id, "failed").ok);
  const r2 = beginRun({ sessionId: "ses_test", objective: "b", workdir: process.cwd() });
  check("queued->completed refused", !transition(r2.id, "completed").ok);
  check("unknown run refused", !transition("run_nope", "running").ok);
  check("transition table sanity", canTransition("running", "checkpointed") && !canTransition("completed", "failed"));

  // 4. durability: run + timeline survive a close/reopen ("restart")
  const before = getAgentRun(run.id);
  const beforeEvents = listRunEvents(run.id).length;
  closeStore();
  initStore();
  const after = getAgentRun(run.id);
  check("run survives reopen", Boolean(after && after.id === before?.id && after.state === "completed"));
  check("timeline survives reopen", listRunEvents(run.id).length === beforeEvents && beforeEvents >= 7, `${listRunEvents(run.id).length} vs ${beforeEvents}`);

  // 5. boot recovery: a run found mid-flight becomes interrupted
  const r3 = beginRun({ sessionId: "ses_rec", objective: "long task", workdir: process.cwd() });
  transition(r3.id, "running");
  closeStore();
  initStore();
  const stale = markStaleRunsInterrupted();
  check("stale run flipped to interrupted", stale.some((s) => s.id === r3.id) && getAgentRun(r3.id)?.state === "interrupted");
  check("interrupted run has ended + recovery event", Boolean(getAgentRun(r3.id)?.ended) && listRunEvents(r3.id).some((e) => e.kind === "run.interrupted"));
  check("terminal runs untouched by recovery", getAgentRun(run.id)?.state === "completed");

  // 6. agent loop integration: no-model turn fails the run honestly
  const turn = await runAgentTurn({ sessionId: "ses_loop", text: "hello", workdir: process.cwd() });
  check("turn reports no model honestly", turn.ok === false && turn.model === "none");
  const loopRuns = listAgentRuns("ses_loop");
  check("turn created exactly one run", loopRuns.length === 1, `${loopRuns.length}`);
  const lr = loopRuns[0];
  check("run failed with the reason", lr?.state === "failed" && /no model/i.test(lr?.error ?? ""), `${lr?.state}/${lr?.error ?? ""}`);
  check("lane recorded as none", lr?.lane === "none", lr?.lane ?? "?");
  const lt = runTimeline(lr!.id);
  check("loop timeline: created -> running -> failed", lt.events[0]?.kind === "run.created" && lt.events.some((e) => e.kind === "state.change" && e.detail.includes("queued -> running")) && lt.events.some((e) => e.kind === "run.failed"));

  // 7. cancel path: terminal, single-shot
  const r4 = beginRun({ sessionId: "ses_c", objective: "c", workdir: process.cwd() });
  transition(r4.id, "running");
  check("cancel ok", cancelRun(r4.id).ok);
  check("double cancel refused", !cancelRun(r4.id).ok);
  check("cancelled is terminal", getAgentRun(r4.id)?.state === "cancelled");

  console.log(failures === 0 ? "[ehc] durable run tests: ALL PASS" : `[ehc] durable run tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] durable run tests crashed:", e); process.exit(1); });
