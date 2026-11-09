// Event Horizon Code — Toolchain Doctor
// Probes PATH via languages/*/language.json toolchain.check. No installs. No network.

import { execFile } from "node:child_process";
import type { LanguagePack } from "./lsp";

export type ToolCheck = {
  lang: string;
  displayName: string;
  cmd: string;
  ok: boolean;
  version: string;
  error?: string;
};

function firstToken(check: string): { cmd: string; args: string[] } {
  const parts = check.trim().split(/\s+/);
  return { cmd: parts[0], args: parts.slice(1) };
}

export function checkToolchain(pack: LanguagePack): Promise<ToolCheck[]> {
  return Promise.all(
    pack.toolchain.check.map(
      (check) =>
        new Promise<ToolCheck>((resolve) => {
          const { cmd, args } = firstToken(check);
          execFile(cmd, args, { timeout: 4000 }, (err, stdout, stderr) => {
            const out = (stdout || stderr || "").trim().split("\n")[0]?.slice(0, 120) ?? "";
            resolve({
              lang: pack.id,
              displayName: pack.displayName,
              cmd: check,
              ok: !err,
              version: out,
              error: err ? String((err as Error).message).slice(0, 200) : undefined,
            });
          });
        })
    )
  );
}

export async function runToolchainDoctor(packs: LanguagePack[]): Promise<ToolCheck[]> {
  const all = await Promise.all(packs.map(checkToolchain));
  return all.flat();
}
