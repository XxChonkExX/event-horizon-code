// Probe v5: EXACT replica of runNamespacedDetonate's script + spawn pattern,
// with the script dumped to disk for diffing against the working probe.
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";

function guestPipeline(opts) {
  const dir = `/tmp/ehc-detonate/${opts.runId}`;
  const lines = [
    "set -e",
    `mkdir -p ${dir}`,
    `cp "${opts.artifactLinuxPath}" ${dir}/${opts.artifactName}`,
    `chmod 644 ${dir}/${opts.artifactName}`,
    "echo delivered=1",
    `command -v /usr/bin/node >/dev/null 2>&1 || { echo "guest node missing - install: wsl -u root apt-get install -y nodejs"; exit 92; }`,
    `unshare --mount --pid --fork --mount-proc --net /bin/sh -c '`,
    ...(opts.hideHostFs ? [
      "  mount --make-rprivate / 2>/dev/null || true",
      "  umount -l /mnt/c 2>/dev/null || true",
      "  echo mntc_files=$(ls /mnt/c 2>/dev/null | wc -l)",
    ] : [
      "  echo mntc_files=n/a",
    ]),
    "  echo netns_ifaces=$(ip -o link show 2>/dev/null | grep -vc \": lo\")",
    "  echo uid_in_ns=$(id -u)",
    `  cd ${dir}`,
    `  exec setpriv --reuid=${opts.guestUid} --regid=${opts.guestUid} --init-groups env -i PATH=/usr/bin:/bin HOME=${dir} /usr/bin/node ${dir}/${opts.artifactName}`,
    "'",
  ];
  return lines.join("\n");
}

function runWslScriptReplica(distro, script, timeoutMs) {
  return new Promise((resolve) => {
    const args = distro ? ["-d", distro, "-u", "root", "--", "/bin/bash", "-s"] : ["-u", "root", "--", "/bin/bash", "-s"];
    const child = spawn("wsl", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, out });
    };
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.stderr?.on("data", (d) => { out += d.toString(); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      resolve({ code: null, out: out + "\n[ehc] wsl runner timed out" });
    }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done(code); });
    child.on("error", () => { clearTimeout(timer); done(-1); });
    child.stdin?.end(script);
  });
}

async function main(): Promise<void> {
  const runId = "det-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  const artifactName = "artifact.mjs";
  const hostArtifact = "C:/Users/mikeh/AppData/Local/Temp/" + "ehc-detonate-" + "probe2" + ".mjs";
  fs.mkdirSync("C:/Users/mikeh/AppData/Local/Temp", { recursive: true });
  fs.writeFileSync(hostArtifact, "const fs = require(\"fs\");\nconsole.log(\"GUEST-MARKER\");\nconsole.log(\"mntc_entries\", (() => { try { return fs.readdirSync(\"/mnt/c\").length; } catch { return \"hidden\"; } })());\n");

  // wslpath via SPAWN exactly like wslPathToLinux
  const artifactLinuxPath = await new Promise<string>((resolve) => {
    const c = spawn("wsl", ["--", "wslpath", "-u", hostArtifact], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let o = "";
    c.stdout?.on("data", (d: Buffer) => { o += d.toString(); });
    c.on("close", (code) => resolve(code === 0 ? o.trim() : ""));
    c.on("error", () => resolve(""));
  });
  console.log("artifactLinuxPath:", JSON.stringify(artifactLinuxPath));

  // guest uid via SPAWN exactly like the runner
  const guestUid = await new Promise<number>((resolve) => {
    const c = spawn("wsl", ["-u", "root", "--", "id", "-u", "nobody"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let o = "";
    c.stdout?.on("data", (d: Buffer) => { o += d.toString(); });
    c.on("close", () => resolve(Number(o.trim()) || 65534));
    c.on("error", () => resolve(65534));
  });
  console.log("guestUid:", guestUid);

  const script = guestPipeline({ runId, artifactLinuxPath, guestUid, hideHostFs: true, artifactName });
  fs.writeFileSync("C:/Users/mikeh/AppData/Local/Temp/opencode/runner-script.sh", script);
  console.log("script dumped; spawning bash -s...");

  const run = await runWslScriptReplica(undefined, script, 22000);
  console.log("runner exit:", run.code, "timed-out:", run.out.includes("timed out"));
  console.log("out:", run.out.trim().slice(0, 600));
  process.exit(0);
}

main().catch((e) => { console.error("probe5 crashed:", e); process.exit(1); });
