// Fixture: seed demo durable runs into a temp EH_DB for UI verification.
import { initStore } from "../../src/server/store";
import { beginRun, transition, completeRun, failRun, appendRunEvent } from "../../src/server/agentrun";

initStore();

// completed run with a tool-call story
const a = beginRun({ sessionId: "ses_demo", objective: "Fix the flaky importer test", workdir: "C:/demo" });
transition(a.id, "running", "agent turn started");
appendRunEvent(a.id, "model.ok", "gemma4:e4b lane=engine tokens=412 attempts=1");
appendRunEvent(a.id, "tool.call", `ls {}`);
appendRunEvent(a.id, "tool.ok", "ls: 24 entries");
appendRunEvent(a.id, "tool.call", `edit {"path":"src/importer.ts"}`);
appendRunEvent(a.id, "tool.ok", "edit: wrote 12 lines");
transition(a.id, "verifying", "self-check");
completeRun(a.id, "Importer test stabilized - the race was a missing await on the fixture setup.");

// interrupted run (restart mid-flight) - resumable
const b = beginRun({ sessionId: "ses_demo", objective: "Migrate the export path to the new writer", workdir: "C:/demo" });
transition(b.id, "running", "agent turn started");
appendRunEvent(b.id, "model.ok", "gemma4:e4b lane=engine tokens=280 attempts=1");
appendRunEvent(b.id, "tool.call", `read {"path":"src/export.ts"}`);
appendRunEvent(b.id, "tool.ok", "read: 96 lines");
transition(b.id, "interrupted", "runtime restarted");

// failed run with the reason on the row
const c = beginRun({ sessionId: "ses_demo", objective: "Rename everything to zebra", workdir: "C:/demo" });
transition(c.id, "running", "agent turn started");
failRun(c.id, "refused by the operator: rename scope too broad");

console.log("fixture runs seeded:", [a.id, b.id, c.id].join(","));
