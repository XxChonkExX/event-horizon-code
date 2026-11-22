// Session fork + checkpoint tests against a temp database (EH_DB). The store
// falls back to in-memory when the native module will not load under plain
// node; behaviour is asserted identically for whichever mode is active.
// Run: npm run sessions:test

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The store only opens the database inside initStore(), so pointing EH_DB at a
// temp file before calling it keeps this test off the real store.
import {
  initStore, createSession, saveMessages, loadMessages, forkSession,
  addCheckpoint, listCheckpoints, messageCount, putInstruction,
  listInstructions, deleteSession, listSessionsWithMeta,
} from "../src/server/store";

process.env.EH_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ehc-sessions-")), "data.db");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  const mode = initStore().mode;
  console.log(`[ehc] session fork/checkpoint tests (store mode: ${mode})`);

  // Source session with 4 messages + a durable instruction
  const src = createSession({ id: "ses_src", title: "original", worktree: process.cwd(), created: new Date().toISOString() });
  saveMessages("ses_src", [
    { role: "user", content: "fix the login bug" },
    { role: "assistant", content: "found it in auth.ts" },
    { role: "user", content: "try approach B instead" },
    { role: "assistant", content: "approach B applied and tested" },
  ]);
  putInstruction("ses_src", "style", "the user prefers tabs");
  check("source has 4 messages", messageCount("ses_src") === 4);

  // Auto-checkpoint per turn (as the agent loop records them)
  addCheckpoint("ses_src", 2, "fix the login bug");
  addCheckpoint("ses_src", 4, "try approach B instead");
  check("checkpoints listed", listCheckpoints("ses_src").length === 2);

  // Fork with full history
  const full = forkSession("ses_src", { title: "approach B window" });
  check("fork creates a session", !!full && !!full.id && full.id !== "ses_src");
  check("fork copies all messages", full ? messageCount(full.id) === 4 : false);
  check("fork copies durable instructions", full ? listInstructions(full.id).some((i) => i.key === "style") : false);
  check("fork is independent of the original", full ? (saveMessages(full.id, [{ role: "user", content: "diverged" }]), messageCount("ses_src") === 4 && messageCount(full.id) === 1) : false);

  // Fork truncated at a checkpoint (revert-to-turn semantics)
  const truncated = forkSession("ses_src", { title: "back to turn 2", atSeq: 2 });
  check("truncated fork has exactly the checkpoint's messages", truncated ? messageCount(truncated.id) === 2 : false);
  check("truncated fork ends at the checkpoint turn", truncated ? (loadMessages(truncated.id).at(-1)?.content ?? "") === "found it in auth.ts" : "");

  // Checkpoint truncation edge: seq 0 = empty fork
  const empty = forkSession("ses_src", { atSeq: 0 });
  check("fork at seq 0 is an empty branch", empty ? messageCount(empty.id) === 0 : false);

  // Fork of a missing session is refused, not fabricated
  check("fork of unknown session refused", forkSession("ses_nope") === null);

  // Cleanup: deleting the source leaves forks intact (no cascading loss)
  deleteSession("ses_src");
  check("deleting the original keeps the full fork", full ? listSessionsWithMeta().some((s) => s.id === full.id) && messageCount(full.id) === 1 : false);

  // Tool-call protocol persistence (external audit Finding A): tool_calls /
  // tool_call_id / name must survive a save/load roundtrip AND a fork, or the
  // replayed conversation contains orphaned tool responses that some
  // providers reject. (Persistence across a full reopen is proven in
  // runs:test; this suite asserts the metadata roundtrip itself.)
  createSession({ id: "ses_proto", title: "proto", worktree: process.cwd(), created: new Date().toISOString() });
  saveMessages("ses_proto", [
    { role: "user", content: "run the import" },
    { role: "assistant", content: "", toolCalls: JSON.stringify([{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }]) },
    { role: "tool", content: "file contents here", toolCallId: "call_1", toolName: "read" },
    { role: "assistant", content: "done" },
  ]);
  const proto = loadMessages("ses_proto");
  check("assistant tool_calls survive reopen", proto.some((m) => m.role === "assistant" && (m.toolCalls ?? "").includes("call_1")));
  const toolRow = proto.find((m) => m.role === "tool");
  check("tool result keeps tool_call_id + name", Boolean(toolRow && toolRow.toolCallId === "call_1" && toolRow.toolName === "read"));
  const protoFork = forkSession("ses_proto");
  const forked = protoFork ? loadMessages(protoFork.id) : [];
  check("fork preserves tool-call protocol", forked.some((m) => (m.toolCalls ?? "").includes("call_1")) && forked.some((m) => m.role === "tool" && m.toolCallId === "call_1"));

  console.log(failures === 0 ? "[ehc] session tests: ALL PASS" : `[ehc] session tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] session tests crashed:", e); process.exit(1); });
