// Event Horizon Code — Runtime initializer
// Creates the runtime folder tree (repo-local + home). Idempotent. Zero deps.
// Run: npm run runtime:init
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const home = path.join(os.homedir(), ".eventhorizon");
const repo = path.join(process.cwd(), ".eventhorizon");

const homeTree = [
  home,
  path.join(home, "models"),        // agnostic default model dir (engine scans here)
  path.join(home, "mail"),          // agent-to-agent mailbox (AgentWatch Phase B sweeps here)
  path.join(home, "aw-ledger"),     // AgentWatch hash-chained ledger + baseline.json + acknowledged.json
  path.join(home, "worktrees"),     // session worktree metadata (worktrees themselves are repo-local)
];
const repoTree = [
  repo,
  path.join(repo, "worktrees"),     // git worktrees: 1 task = 1 window = 1 worktree
  path.join(repo, "vault"),         // canary registry (HMAC-keyed bait)
];

let created = 0;
for (const dir of [...homeTree, ...repoTree]) {
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); created++; }
}

// Runtime manifest: what booted, where things live
const manifestPath = path.join(home, "runtime.json");
const manifest = {
  created: new Date().toISOString(),
  home,
  repo,
  auditLog: path.join(home, "audit.jsonl"),
  db: path.join(home, "data.db"),
  ledger: path.join(home, "aw-ledger"),
  mailbox: path.join(home, "mail"),
  notes: [
    "All data local. No telemetry. Delete this tree to reset everything.",
    "Default server port 4126 (EH_PORT), Basic auth user 'eventhorizon' (EH_PASS).",
  ],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`[ehc] runtime ready — ${created} dir(s) created, ${homeTree.length + repoTree.length - created} existing`);
console.log(`[ehc] home tree:  ${home}{/mail,/aw-ledger,/worktrees}`);
console.log(`[ehc] repo tree:  ${repo}{/worktrees,/vault}`);
console.log(`[ehc] manifest:   ${manifestPath}`);
