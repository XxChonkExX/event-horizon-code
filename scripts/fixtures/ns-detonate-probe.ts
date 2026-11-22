// NS runner probe: drive runNamespacedDetonate directly (the real backend
// function) against a temp git worktree + ESM marker artifact.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildDetonatePlan, runNamespacedDetonate } from "../../src/server/detonate";

const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-det-probe-"));
const git = (args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" });
git(["init", "-q"]); git(["config", "user.email", "t@t"]); git(["config", "user.name", "t"]);
fs.writeFileSync(path.join(worktree, "keep.txt"), "host\n");
git(["add", "."]); git(["commit", "-q", "-m", "init"]);

const artifact = path.join(worktree, "det-art.mjs");
fs.writeFileSync(artifact, 'import fs from "node:fs";\nconsole.log("GUEST-MARKER");\ntry { console.log("mntc_entries", fs.readdirSync("/mnt/c").length); } catch { console.log("mntc_entries", "hidden"); }\nconsole.log("net", require_probe());\nfunction require_probe() { return "n/a"; }\n');

const plan = buildDetonatePlan(worktree, "execute", artifact);
plan.timeoutMs = 20000;
console.log("plan args:", plan.args.join(" "));
console.log("plan artifactPath:", plan.artifactPath);

const t0 = Date.now();
async function main(): Promise<void> {
  const r = await runNamespacedDetonate(plan, { mode: "wsl" });
  console.log("elapsed:", Date.now() - t0, "ms");
  console.log("result:", JSON.stringify({ code: r.code, killed: r.killed, backend: r.backend, delivered: r.delivered, networkVerified: r.networkVerified, hostFsHidden: r.hostFsHidden, treeTerminated: r.treeTerminated, missing: r.missing ?? false }));
  console.log("--- guest log ---");
  console.log(r.guestLog.trim().slice(0, 800));
}
main().then(() => process.exit(0)).catch((e) => { console.error("probe crashed:", e); process.exit(1); });
