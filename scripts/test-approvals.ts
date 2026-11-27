// Approvals and grants tests - fully offline. Covers the module (requests,
// grants, policy, timeouts, the SSE events) and the tool gate in `runTool`:
// an `ask` tool executes only through an operator-owned source, and a
// decision is bound to exactly the arguments that were requested.
// Run: npm run approvals:test

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  callDigest, cancelPending, changedLines, consumeGrant, decideApproval, getApprovalPolicy,
  isDeniedInRun, listApprovals, listGrants, requestApproval, revokeGrant, setApprovalPolicy, summarizeCall,
} from "../src/server/approvals";
import type { GrantSpec } from "../src/server/approvals";
import { runTool } from "../src/server/tools";
import type { AskHandler } from "../src/server/tools";
import { subscribe } from "../src/server/sse";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pendingOnly = (): ReturnType<typeof listApprovals> => listApprovals().filter((r) => r.status === "pending");
const summary = (title: string, detail = title) => ({ kind: "generic" as const, title, detail });

/** Raise a request and wait until it is pending; returns its id. */
async function raise(sessionId: string, tool: string, args: Record<string, unknown>): Promise<string> {
  void requestApproval({ sessionId, worktree: path.join(os.tmpdir(), "ehc-approvals-raise"), tool, args, summary: summary(tool) }).catch(() => { /* resolved by the caller's decision */ });
  for (let i = 0; i < 40 && !pendingOnly().some((r) => r.sessionId === sessionId); i++) await sleep(25);
  return pendingOnly().find((r) => r.sessionId === sessionId)!.id;
}

async function main(): Promise<void> {
  console.log("[ehc] approvals tests");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-approvals-"));
  process.env.EH_AUDIT_LOG = path.join(tmp, "audit.jsonl");
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\nthree\n");
  const cwd0 = process.cwd();
  process.chdir(tmp); // no .harness/config.json here: edit/write/bash are `ask`
  const WT = path.join(tmp, "wt");

  // 1. Identity of a call.
  const d1 = callDigest("bash", { cmd: "npm test", x: 1, y: [1, { b: 2, a: 3 }] });
  check("a call's identity ignores key order", d1 === callDigest("bash", { y: [1, { a: 3, b: 2 }], x: 1, cmd: "npm test" }));
  check("different arguments are a different call", d1 !== callDigest("bash", { cmd: "npm test ", x: 1, y: [1, { b: 2, a: 3 }] }));
  check("a different tool is a different call", d1 !== callDigest("verify", { cmd: "npm test", x: 1, y: [1, { b: 2, a: 3 }] }));

  // 2. What the human reads.
  const diff = changedLines("one\ntwo\nthree\nfour\n", "one\nTWO\nthree\nfour\n");
  check("a change shows only the lines that differ", diff.includes("@@ around line 2 (1 removed, 1 added) @@") && diff.includes("- two") && diff.includes("+ TWO") && !diff.includes("one"), diff);
  check("identical content says so", changedLines("same\n", "same\n") === "(no change - the content is identical)");
  const readIn = (rel: string): { text: string; truncated?: boolean; bytes?: number } | null => (fs.existsSync(path.join(ws, rel)) ? { text: fs.readFileSync(path.join(ws, rel), "utf8") } : null);
  const editSum = summarizeCall("edit", { path: "a.txt", newText: "one\nTWO\nthree\n" }, readIn);
  check("an edit summarises as a diff of the real file", editSum.kind === "edit" && editSum.title === "Edit a.txt" && editSum.detail.includes("+ TWO") && editSum.detail.includes("- two"));
  const noFile = summarizeCall("edit", { path: "missing.txt", newText: "x\n" }, readIn);
  check("an edit to a file that does not exist says the edit cannot apply (edit never creates)", noFile.title === "Edit missing.txt" && noFile.detail.includes("does not exist"), noFile.detail);
  const bigFile = summarizeCall("edit", { path: "big.txt", newText: "new\n" }, () => ({ text: "", truncated: true, bytes: 5 * 1048576 }));
  check("a file too large to diff is stated, with the content that replaces it", bigFile.detail.includes("too large to show a diff") && bigFile.detail.includes("REPLACES all of it") && bigFile.detail.includes("--- new content ---\nnew"), bigFile.detail);
  const newSum = summarizeCall("write", { path: "new.txt", content: "hello\n" }, readIn);
  check("a write to a new file says it creates it", newSum.kind === "write" && newSum.title.startsWith("Create new.txt") && newSum.detail.includes("hello"));
  const bashSum = summarizeCall("bash", { cmd: "npm test -- --watchAll=false" });
  check("a command is shown as the command", bashSum.kind === "bash" && bashSum.title === "Run: npm test -- --watchAll=false" && bashSum.detail === "npm test -- --watchAll=false");
  const longSum = summarizeCall("write", { path: "x", content: "y".repeat(9000) });
  check("a huge change is clipped for display", longSum.detail.length < 4300 && longSum.detail.includes("more characters"));

  // 3. A request waits, is listed, announces itself, and resolves on a decision.
  const events: Array<{ event: string; data: string }> = [];
  const sse = http.createServer((_req, res) => subscribe(WT, res));
  await new Promise<void>((r) => sse.listen(0, "127.0.0.1", () => r()));
  const ssePort = (sse.address() as { port: number }).port;
  const abort = new AbortController();
  const reader = (await fetch(`http://127.0.0.1:${ssePort}/api/events`, { signal: abort.signal })).body!.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /event: (\S+)/.exec(chunk)?.[1];
        if (ev) events.push({ event: ev, data: /data: (.*)/s.exec(chunk)?.[1] ?? "" });
      }
    }
  })().catch(() => { /* aborted at the end */ });

  const args = { cmd: "echo hi" };
  let decided = false;
  const p1 = requestApproval({ sessionId: "s1", runId: "r1", worktree: WT, tool: "bash", args, summary: summary("Run: echo hi", "echo hi") }).then((d) => { decided = true; return d; });
  await sleep(350);
  const listed = pendingOnly();
  check("a request waits for the operator", !decided && listed.length === 1 && listed[0]!.tool === "bash" && listed[0]!.sessionId === "s1" && listed[0]!.runId === "r1");
  check("the request is bound to its exact arguments and the policy's timeout", listed[0]?.argsDigest === callDigest("bash", args) && listed[0]?.expiresAt! - listed[0]?.createdAt! === getApprovalPolicy().requestTimeoutMs);
  await sleep(50);
  const announced = events.find((e) => e.event === "approval");
  check("the window is told a request is waiting (SSE `approval`)", !!announced && JSON.parse(announced!.data).request?.id === listed[0]?.id);
  const dec1 = decideApproval(listed[0]!.id, { approved: true });
  const r1 = await p1;
  check("an approval resolves the wait as approved", dec1.ok && r1.approved === true && r1.reason === "approved" && r1.grantId === null);
  check("the decision is recorded", listApprovals().find((r) => r.id === listed[0]!.id)?.status === "approved");
  await sleep(150);
  check("…and announced to the window (SSE `approval-resolved`)", events.some((e) => e.event === "approval-resolved" && JSON.parse(e.data).status === "approved"));
  check("a second decision on the same request is refused", !decideApproval(listed[0]!.id, { approved: true }).ok);
  check("an unknown request is refused", !decideApproval("apr_nope", { approved: true }).ok);

  // 4. A denial is final for that call in that run, and never mints authority.
  const p2 = requestApproval({ sessionId: "s1", runId: "r1", worktree: WT, tool: "bash", args: { cmd: "rm -rf x" }, summary: summary("Run: rm -rf x", "rm -rf x") });
  await sleep(150);
  const denyId = pendingOnly()[0]!.id;
  const denied = decideApproval(denyId, { approved: false, grant: { scope: "tool" } });
  check("a denial that carries a grant is refused, mints nothing and stays pending", !denied.ok && listGrants().length === 0 && pendingOnly().some((r) => r.id === denyId));
  check("a plain denial resolves as denied", decideApproval(denyId, { approved: false }).ok && (await p2).reason === "denied");
  check("the declined call is remembered for its run, and only that call", isDeniedInRun("r1", "bash", callDigest("bash", { cmd: "rm -rf x" })) && !isDeniedInRun("r1", "bash", callDigest("bash", { cmd: "rm -rf y" })) && !isDeniedInRun("r2", "bash", callDigest("bash", { cmd: "rm -rf x" })));

  // 5. Nobody answers: a stated non-execution, and cancellation ends the wait at once.
  const pol0 = getApprovalPolicy();
  check("policy bounds are validated", !setApprovalPolicy({ requestTimeoutMs: 10 }).ok && !setApprovalPolicy({ grantMaxUses: 0 }).ok && setApprovalPolicy({ requestTimeoutMs: 1000 }).ok);
  const t0 = Date.now();
  const r5 = await requestApproval({ sessionId: "s1", worktree: WT, tool: "edit", args: { path: "a", newText: "b" }, summary: summary("Edit a") });
  check("an unanswered request expires with a stated reason", r5.approved === false && r5.reason === "expired" && Date.now() - t0 >= 900);
  setApprovalPolicy({ requestTimeoutMs: pol0.requestTimeoutMs });
  let cancelMe = false;
  const p6 = requestApproval({ sessionId: "s1", worktree: WT, tool: "edit", args: { path: "a", newText: "b" }, summary: summary("Edit a") }, { isCancelled: () => cancelMe });
  await sleep(150);
  cancelMe = true;
  const t6 = Date.now();
  check("a cancelled run ends its wait promptly", (await p6).reason === "cancelled" && Date.now() - t6 < 900);
  const p7 = requestApproval({ sessionId: "s9", worktree: WT, tool: "edit", args: { path: "a", newText: "b" }, summary: summary("Edit a") });
  const p7b = requestApproval({ sessionId: "s9", runId: "r9", worktree: WT, tool: "edit", args: { path: "a", newText: "c" }, summary: summary("Edit a") });
  await sleep(150);
  check("cancelling a session ends its pending requests", cancelPending({ sessionId: "s9" }) === 2 && (await p7).reason === "cancelled" && (await p7b).reason === "cancelled" && pendingOnly().length === 0);

  // 6. Grants answer a call without a prompt, within their bounds.
  const npmId = await raise("sg", "bash", { cmd: "npm test" });
  const g1 = decideApproval(npmId, { approved: true, grant: { scope: "args", uses: 2, label: "npm test" } });
  const grant = listGrants()[0];
  check("an approval may create a grant bound to that exact call", g1.ok && listGrants().length === 1 && grant?.argsDigest === callDigest("bash", { cmd: "npm test" }) && grant.maxUses === 2 && grant.label === "npm test");
  const npm = callDigest("bash", { cmd: "npm test" });
  check("a grant never covers another call, another tool or another session", consumeGrant("sg", "bash", callDigest("bash", { cmd: "npm run build" })) === null && consumeGrant("sg", "edit", npm) === null && consumeGrant("other", "bash", npm) === null);
  check("the grant answers that call and consumes a use each time", consumeGrant("sg", "bash", npm)?.id === grant?.id && listGrants()[0]?.used === 1 && consumeGrant("sg", "bash", npm)?.id === grant?.id);
  check("an exhausted grant answers nothing", consumeGrant("sg", "bash", npm) === null && listGrants().length === 0);

  const max = getApprovalPolicy();
  const bounded = await raise("sg2", "bash", { cmd: "a" });
  const bad = [(): GrantSpec => ({ scope: "args", uses: 0 }), (): GrantSpec => ({ scope: "args", uses: max.grantMaxUses + 1 }), (): GrantSpec => ({ scope: "tool", ttlMs: max.grantMaxTtlMs + 1 }), (): GrantSpec => ({ scope: "bogus", uses: 1 } as unknown as GrantSpec)];
  check("a grant's uses, ttl and scope are bounded by policy", bad.every((spec) => !decideApproval(bounded, { approved: true, grant: spec() }).ok));
  check("those refusals mint nothing and leave the request pending", listGrants().length === 0 && pendingOnly().some((r) => r.id === bounded));
  check("a tool-wide grant covers any arguments of that tool, in that session only", decideApproval(bounded, { approved: true, grant: { scope: "tool" } }).ok
    && !!consumeGrant("sg2", "bash", callDigest("bash", { cmd: "anything" })) && !!consumeGrant("sg2", "bash", callDigest("bash", { cmd: "else" }))
    && consumeGrant("sg2", "edit", callDigest("edit", { path: "x" })) === null && consumeGrant("sg2x", "bash", callDigest("bash", { cmd: "anything" })) === null);
  const ttlReq = await raise("sg3", "edit", { path: "x", newText: "y" });
  decideApproval(ttlReq, { approved: true, grant: { scope: "tool", ttlMs: 1000 } });
  const live = !!consumeGrant("sg3", "edit", callDigest("edit", { path: "z", newText: "q" }));
  await sleep(1200);
  check("a grant lives for its ttl, then is gone", live && consumeGrant("sg3", "edit", callDigest("edit", { path: "z", newText: "q" })) === null);
  const revReq = await raise("sg4", "edit", { path: "x", newText: "y" });
  decideApproval(revReq, { approved: true, grant: { scope: "tool" } });
  const revId = listGrants().find((g) => g.sessionId === "sg4")!.id;
  check("a revoked grant answers nothing", revokeGrant(revId) && !revokeGrant(revId) && consumeGrant("sg4", "edit", callDigest("edit", { path: "x", newText: "y" })) === null);

  // A tool that asks on every use is never covered by a grant (PRIVACY.md
  // promises each camera look asks), and the policy may only add to that list.
  const camId = await raise("sg5", "camera_look", { question: "who is there?" });
  check("a tool that asks on every use can never be covered by a grant", !decideApproval(camId, { approved: true, grant: { scope: "tool" } }).ok && !decideApproval(camId, { approved: true, grant: { scope: "args", uses: 5 } }).ok && listGrants().every((g) => g.tool !== "camera_look") && pendingOnly().some((r) => r.id === camId));
  const floor = getApprovalPolicy().noGrantTools;
  check("the policy may add such tools, never drop one", !setApprovalPolicy({ noGrantTools: [] }).ok && setApprovalPolicy({ noGrantTools: [...floor, "a_future_sensor"] }).ok && !setApprovalPolicy({ noGrantTools: ["a_future_sensor"] }).ok && setApprovalPolicy({ noGrantTools: floor }).ok);
  decideApproval(camId, { approved: false });
  check("…and it still asks normally, one decision at a time", listApprovals().find((r) => r.id === camId)?.status === "denied");

  // 7. The tool gate. Nothing the model writes can approve anything; only the
  //    three operator-owned sources can.
  const file = (): string => fs.readFileSync(path.join(ws, "a.txt"), "utf8");
  let asked = 0;
  const refuse: AskHandler = async () => { asked++; return "denied"; };
  const noHook = await runTool("edit", { path: "a.txt", newText: "one\nTWO\nthree\n" }, ws);
  check("with no way to ask a human, an `ask` tool is a stated non-execution", noHook.ok === false && noHook.needsApproval === true && !!noHook.out?.includes("needs the user's approval") && !noHook.out?.includes("Review pane") && file() === "one\ntwo\nthree\n", noHook.out);
  const modelLie = await runTool("edit", { path: "a.txt", approved: true, newText: "one\nTWO\nthree\n" }, ws, { onAsk: refuse });
  check("`approved: true` in the model's arguments approves nothing", modelLie.ok === false && asked === 1 && file() === "one\ntwo\nthree\n");
  const declined = await runTool("edit", { path: "a.txt", newText: "one\nTWO\nthree\n" }, ws, { sessionId: "s7", onAsk: refuse });
  check("a declined request leaves the workspace untouched and says why", declined.ok === false && declined.error === "approval denied" && !!declined.out?.includes("the user declined this action") && file() === "one\ntwo\nthree\n", declined.out);
  const operator = await runTool("edit", { path: "a.txt", newText: "one\nTWO\nthree\n" }, ws, { userApproved: true, onAsk: refuse });
  check("the operator channel's explicit approval executes without a prompt", operator.ok === true && asked === 2 && file() === "one\nTWO\nthree\n");
  fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\nthree\n");

  // End to end: the gate asks, the operator approves "in the window", the
  // exact requested call executes.
  let prompts = 0;
  const askFor = (session: string): AskHandler => async ({ tool, args: a, summary: s }) => {
    prompts++;
    return (await requestApproval({ sessionId: session, runId: "run-e2e", worktree: WT, tool, args: a, summary: s })).reason;
  };
  const turn = runTool("edit", { path: "a.txt", newText: "one\nTWO\nthree\n" }, ws, { sessionId: "s8", onAsk: askFor("s8") });
  for (let i = 0; i < 40 && pendingOnly().length === 0; i++) await sleep(25);
  const card = pendingOnly()[0];
  check("the gate raises a request carrying the diff the human must see", !!card && card.sessionId === "s8" && card.runId === "run-e2e" && card.summary.kind === "edit" && card.summary.detail.includes("+ TWO"), JSON.stringify(card?.summary));
  decideApproval(card!.id, { approved: true });
  const done = await turn;
  check("approving the request executes exactly the requested edit", done.ok === true && file() === "one\nTWO\nthree\n");

  // 8. A grant answers the gate without asking.
  const promptsBefore = prompts;
  const first = runTool("edit", { path: "a.txt", newText: "one\nTWO\nthree\n" }, ws, { sessionId: "s10", onAsk: askFor("s10") });
  for (let i = 0; i < 40 && pendingOnly().length === 0; i++) await sleep(25);
  decideApproval(pendingOnly()[0]!.id, { approved: true, grant: { scope: "args", uses: 1 } });
  await first;
  check("the approved call has been asked once so far", prompts === promptsBefore + 1);
  const again = await runTool("edit", { path: "a.txt", newText: "one\nTWO\nthree\n" }, ws, { sessionId: "s10", onAsk: askFor("s10") });
  check("the same call again is answered by the grant, with no prompt", again.ok === true && prompts === promptsBefore + 1);
  const other = runTool("edit", { path: "a.txt", newText: "one\ntwo\nTHREE\n" }, ws, { sessionId: "s10", onAsk: askFor("s10") });
  for (let i = 0; i < 40 && pendingOnly().length === 0; i++) await sleep(25);
  check("a different call still asks", pendingOnly().length === 1 && prompts === promptsBefore + 2);
  decideApproval(pendingOnly()[0]!.id, { approved: false });
  const viaModel = runTool("edit", { path: "a.txt", sessionId: "s10", newText: "one\ntwo\nTHREE\n" }, ws, { sessionId: "s11", onAsk: refuse });
  check("…and a `sessionId` in the model's arguments reaches no other session's grants", (await other).ok === false && (await viaModel).ok === false && file() === "one\nTWO\nthree\n");

  // 9. Nothing is left waiting.
  check("no request is left pending", pendingOnly().length === 0);

  abort.abort();
  sse.closeAllConnections?.();
  await new Promise<void>((r) => sse.close(() => r()));
  process.chdir(cwd0);
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures) { console.error(`[ehc] approvals tests: ${failures} FAILURE(S)`); process.exit(1); }
  console.log("[ehc] approvals tests: ALL PASS");
}

main().catch((e) => { console.error("[ehc] approvals tests crashed:", e); process.exit(1); });
