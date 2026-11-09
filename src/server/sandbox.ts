// Event Horizon Code — Sandbox manager
// Modes: host (default clean), docker (plain container), sbx (microVM clone), detonate (unclean chamber).
// Opt-in only. Disabled by default while CodeRed-418 trains on B70.
// Never shares host Docker socket. Never bundles Docker Desktop.
// Clean vs Unclean: clean worktrees never receive untrusted code. Unclean interactions route to detonate.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type SandboxMode = "host" | "docker" | "sbx" | "detonate";
export type NetworkPolicy = "off" | "balanced" | "strict";
export type SandboxConfig = {
  mode: SandboxMode;
  network: NetworkPolicy;
  worktree: string;
  sandboxName?: string;
  image?: string;
};

export type DoctorResult = { tool: string; ok: boolean; version: string };

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: ((stdout as string) || (stderr as string) || "").trim().split("\n")[0]?.slice(0, 160) ?? "" });
    });
  });
}

export async function checkSandboxTools(): Promise<DoctorResult[]> {
  const checks: Array<[string, string[]]> = [
    ["docker", ["--version"]],
    ["sbx", ["--version"]],
    ["podman", ["--version"]],
  ];
  const results: DoctorResult[] = [];
  for (const [tool, args] of checks) {
    const r = await run(tool, args);
    results.push({ tool, ok: r.ok, version: r.out });
  }
  return results;
}

export function readWorktreeConfig(worktree: string): SandboxConfig {
  const file = path.join(worktree, ".eventhorizon", "worktree.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SandboxConfig>;
    return {
      mode: (raw.mode as SandboxMode) ?? "host",
      network: (raw.network as NetworkPolicy) ?? "balanced",
      worktree,
      sandboxName: raw.sandboxName,
      image: raw.image ?? "eventhorizon/agent:latest",
    };
  } catch {
    return { mode: "host", network: "balanced", worktree };
  }
}

export function writeWorktreeConfig(cfg: SandboxConfig) {
  const dir = path.join(cfg.worktree, ".eventhorizon");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "worktree.json"), JSON.stringify(cfg, null, 2));
}

// Commands built for UI. Nothing executes automatically.
// sbx clone mode: private clone inside VM, push branches to origin, PR for review.
export function buildSbxCommand(cfg: SandboxConfig): string {
  if (cfg.mode !== "sbx") return "";
  const name = cfg.sandboxName ?? path.basename(cfg.worktree);
  return `sbx run --clone ${name} ${cfg.worktree} --network ${cfg.network}`;
}

export function buildDockerCommand(cfg: SandboxConfig): string {
  if (cfg.mode !== "docker") return "";
  const image = cfg.image ?? "eventhorizon/agent:latest";
  const netFlags = cfg.network === "strict" ? "--network none" : cfg.network === "balanced" ? "--network bridge" : "--network none";
  // NOTE: no -v /var/run/docker.sock mounts. No host $HOME mounts. Worktree only.
  return `docker run --rm -it ${netFlags} -v ${cfg.worktree}:/workspace -w /workspace ${image} bash`;
}
