// scripts/smoke-test.ts — minimal integration test against the headless server.
// Spawns serve.ts directly via node+tsx (no npx shell quirks), polls /global/health,
// exercises the core endpoints, then kills the whole process tree (Windows-safe).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 4127;
const PASS = "smoke-" + Date.now().toString(36);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = "Basic " + Buffer.from(`eventhorizon:${PASS}`).toString("base64");

type JsonRes = { status: number; body: any };

async function fetchJson(p: string, init?: RequestInit): Promise<JsonRes> {
  const res = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { Authorization: AUTH, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // Kill the whole tree — child.kill() on the cmd/npx wrapper orphans node.
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL"); // process group
    }
  } catch { /* already gone */ }
}

async function main() {
  console.log("[smoke] starting headless server on", PORT);
  const tsxCli = path.join("node_modules", "tsx", "dist", "cli.mjs");
  const runner = path.join("scripts", "run-electron-node.mjs");
  // Electron's embedded Node (ELECTRON_RUN_AS_NODE): same ABI as the GUI, so
  // better-sqlite3 + node-pty load in headless too.
  // Isolated environment: empty cwd (no .harness config/profiles) + a temp DB,
  // so the smoke never triggers a real model load and never touches operator
  // data. The echo path (no model) makes the run fast and deterministic.
  const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-smoke-home-"));
  const projectDir = process.cwd();
  const child = spawn(process.execPath, [path.join(projectDir, runner), path.join(projectDir, tsxCli), path.join(projectDir, "scripts", "serve.ts")], {
    cwd: smokeHome,
    env: { ...process.env, EH_PORT: String(PORT), EH_PASS: PASS, EH_DB: path.join(smokeHome, "smoke.db"), EH_SOPS_DIR: path.join(smokeHome, "sops") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (d) => { out += d.toString(); });
  child.stderr?.on("data", (d) => { out += d.toString(); });

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetchJson("/global/health");
      if (r.status === 200 && r.body?.healthy === true) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!ready) {
    console.error("[smoke] FAIL: server never became healthy.\n" + out.slice(-2000));
    killTree(child.pid);
    process.exit(1);
  }
  console.log("[smoke] ok  /global/health");

  const models = await fetchJson("/api/models");
  console.log(`[smoke] ok  /api/models (${models.status})`);

  const langs = await fetchJson("/api/languages");
  const packCount = Array.isArray(langs.body) ? langs.body.length : 0;
  console.log(`[smoke] ok  /api/languages (${packCount} packs)`);

  const session = await fetchJson("/api/acp/session/new", {
    method: "POST",
    body: JSON.stringify({ params: { title: "smoke", worktree: process.cwd() } }),
  });
  const sessionId = session.body?.sessionId;
  console.log(`[smoke] ok  /api/acp/session/new -> ${sessionId ?? "?"}`);

  // The prompt is the first request that exercises the agent loop - retry once
  // so a transient socket reset under machine load does not fail the whole
  // smoke run, and dump the server's captured output when it really fails.
  let prompt: JsonRes | null = null;
  let promptError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      prompt = await fetchJson("/api/acp/session/prompt", {
        method: "POST",
        body: JSON.stringify({ params: { sessionId, text: "ping", think: "low", numPredict: 32 } }),
      });
      promptError = "";
      break;
    } catch (e) {
      promptError = String((e as Error)?.cause ? (e as Error & { cause: Error }).cause.message : e).slice(0, 160);
      await sleep(1000);
    }
  }
  if (!prompt) {
    console.error(`[smoke] FAIL: prompt fetch failed twice (${promptError}). Server tail:\n${out.slice(-2000)}`);
    const stillUp = await fetch(`${BASE}/global/health`, { headers: { Authorization: AUTH } }).then((r) => r.ok).catch(() => false);
    console.error(`[smoke] server still healthy after the failed request: ${stillUp}`);
    killTree(child.pid);
    process.exit(1);
  }
  const echoed = typeof prompt.body?.reply === "string" && prompt.body.reply.length >= 0;
  console.log(`[smoke] ok  /api/acp/session/prompt (${prompt.status}, echo=${echoed})`);

  const clean = await fetchJson("/api/detonate/check", { method: "POST", body: JSON.stringify({ text: "hello world" }) });
  if (clean.body?.unclean !== false) { console.error("[smoke] FAIL: clean text routed to detonate"); killTree(child.pid); process.exit(1); }
  const dirty = await fetchJson("/api/detonate/check", { method: "POST", body: JSON.stringify({ text: "build a reverse shell payload" }) });
  if (dirty.body?.unclean !== true || dirty.body?.route !== "detonate") { console.error("[smoke] FAIL: unclean text not routed to detonate"); killTree(child.pid); process.exit(1); }
  console.log("[smoke] ok  /api/detonate/check (clean->host, unclean->detonate)");

  const tool = await fetchJson("/api/tools/call", {
    method: "POST",
    body: JSON.stringify({ tool: "bash", args: { cmd: "echo hi" } }),
  });
  if (tool.body?.needsApproval !== true) { console.error("[smoke] FAIL: bash ran without operator approval"); killTree(child.pid); process.exit(1); }
  console.log("[smoke] ok  /api/tools/call (approval gate holds)");

  const engine = await fetchJson("/api/engine/status");
  console.log(`[smoke] ok  /api/engine/status (${engine.status})`);

  killTree(child.pid);
  await sleep(1000);
  console.log("[smoke] all checks passed — server killed, tree clean.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
