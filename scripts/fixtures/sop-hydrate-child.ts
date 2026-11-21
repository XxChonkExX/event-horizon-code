// Hydration fixture: starts a GATED SOP run that pauses at its script node
// (waiting for approval), prints the run id, and exits - simulating a runtime
// restart while a run awaits an operator. The parent test then hydrates the
// run from disk (fresh Map) and approves it. EH_SOPS_DIR comes from env.
import fs from "node:fs";
import path from "node:path";
import { startRun, getRun } from "../../src/server/sop";

async function main(): Promise<void> {
  const dir = process.env.EH_SOPS_DIR;
  if (!dir) { console.error("EH_SOPS_DIR not set"); process.exit(1); }
  const sop = { name: "hydrate-me", nodes: [{ id: "s1", type: "script", label: "Gated step", cmd: `node -e "console.log('after-restart-ok')"` }] };
  fs.writeFileSync(path.join(dir, "hydrate-me.json"), JSON.stringify(sop, null, 2));
  const r = startRun("hydrate-me", { worktree: process.cwd() });
  if (!r.ok || !r.run) { console.error(r.error ?? "start failed"); process.exit(1); }
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const run = getRun(r.run.id);
    if (run?.status === "waiting" && run.pendingCommand) { console.log(r.run.id); process.exit(0); }
    await new Promise((res) => setTimeout(res, 50));
  }
  console.error("never reached waiting");
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
