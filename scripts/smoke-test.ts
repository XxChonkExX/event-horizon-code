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
  // The secrets checks below write keys: pin the file inside the smoke home so
  // the operator's real .harness/secrets.json is never in play.
  const secretsFile = path.join(smokeHome, "secrets.json");
  const projectDir = process.cwd();
  const child = spawn(process.execPath, [path.join(projectDir, runner), path.join(projectDir, tsxCli), path.join(projectDir, "scripts", "serve.ts")], {
    cwd: smokeHome,
    // POSIX group kill in killTree() requires the child to be a process-group
    // leader. Without `detached`, process.kill(-pid) fails, the child survives
    // and keeps our captured pipes open -> the CI runner hangs forever.
    detached: process.platform !== "win32",
    env: { ...process.env, EH_PORT: String(PORT), EH_PASS: PASS, EH_DB: path.join(smokeHome, "smoke.db"), EH_SOPS_DIR: path.join(smokeHome, "sops"), EH_SECRETS_FILE: secretsFile },
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

  // Durable Agent Run (Phase 1): the echo turn created a run record even with
  // no model - failed honestly, with a timeline.
  const runs = await fetchJson(`/api/runs?sessionId=${encodeURIComponent(sessionId ?? "")}`);
  const smokeRun = Array.isArray(runs.body) ? runs.body[0] : null;
  if (!smokeRun || smokeRun.state !== "failed" || !/no model/i.test(smokeRun.error ?? "")) {
    console.error(`[smoke] FAIL: expected one failed no-model run, got: ${JSON.stringify(runs.body).slice(0, 300)}`);
    killTree(child.pid);
    process.exit(1);
  }
  const timeline = await fetchJson(`/api/runs/${encodeURIComponent(smokeRun.id)}/timeline`);
  const evs = Array.isArray(timeline.body?.events) ? timeline.body.events : [];
  if (!timeline.body?.run || evs.length < 3 || !evs.some((e: any) => e.kind === "run.failed")) {
    console.error("[smoke] FAIL: run timeline missing (created/running/failed events)");
    killTree(child.pid);
    process.exit(1);
  }
  console.log(`[smoke] ok  /api/runs (run recorded + failed honestly, ${evs.length} timeline events)`);

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

  // BYOK secrets (docs/ENCRYPTION.md, E1) over the real HTTP surface. This
  // runtime is headless (ELECTRON_RUN_AS_NODE): no OS keychain. Everything
  // below asserts the headless contract - the state is reported as it is, a
  // refused request touches nothing, and an encrypted key becomes a stated
  // failure. The keychain path itself is proven by secrets:test:electron.
  const fail = (msg: string, detail?: unknown): never => {
    console.error(`[smoke] FAIL: ${msg}${detail !== undefined ? ` - ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
    killTree(child.pid);
    process.exit(1);
  };
  const secStatus = await fetchJson("/api/secrets/status");
  if (secStatus.status !== 200 || secStatus.body?.encryptionAvailable !== false || secStatus.body?.storage !== "plaintext-only" || !Array.isArray(secStatus.body?.providers)) {
    fail("secrets status must report the headless truth (no keychain, plaintext-only)", secStatus.body);
  }
  const secBad = await fetchJson("/api/secrets", { method: "POST", body: JSON.stringify({ provider: "../evil", apiKey: "x" }) });
  if (secBad.status !== 400 || secBad.body?.ok !== false || fs.existsSync(secretsFile)) {
    fail("an invalid provider must be refused without creating a secrets file", secBad.body);
  }
  const SMOKE_KEY = "smoke-key-" + "z".repeat(20);
  const secSave = await fetchJson("/api/secrets", {
    method: "POST",
    body: JSON.stringify({ provider: "smokeprov", baseUrl: "https://api.example.com/v1", apiKey: SMOKE_KEY }),
  });
  if (secSave.status !== 200 || secSave.body?.ok !== true || secSave.body?.encrypted !== false) {
    fail("a headless save must succeed and say it stored PLAINTEXT", secSave.body);
  }
  const secListed = await fetchJson("/api/secrets/status");
  const sp = secListed.body?.providers?.find((p: any) => p.provider === "smokeprov");
  if (!sp || sp.hasKey !== true || sp.encrypted !== false || JSON.stringify(secListed.body).includes(SMOKE_KEY)) {
    fail("status must list the provider and never carry the key", secListed.body);
  }
  const secSnap = fs.readFileSync(secretsFile, "utf8");
  const secEnc = await fetchJson("/api/secrets/encrypt", { method: "POST", body: "{}" });
  if (secEnc.status !== 400 || secEnc.body?.ok !== false || !/desktop app/.test(secEnc.body?.error ?? "") || fs.readFileSync(secretsFile, "utf8") !== secSnap) {
    fail("encrypt without a keychain must be refused and leave the file byte-identical", secEnc.body);
  }
  const secDel = await fetchJson("/api/secrets/smokeprov", { method: "DELETE" });
  if (secDel.status !== 200 || secDel.body?.ok !== true) fail("delete a stored secret", secDel.body);
  // A key sealed by the desktop app, read by a runtime with no keychain: the
  // prompt fails with the reason (the loop's shape for a failed model call:
  // the text lands in `reply`, the run record gets `error`) - not a generic
  // "no key", and no request goes out (the refusal precedes the endpoint call).
  fs.writeFileSync(secretsFile, JSON.stringify({ openai: { baseUrl: "https://api.example.com/v1", apiKey: "enc1:AAAA" } }));
  const secPrompt = await fetchJson("/api/acp/session/prompt", {
    method: "POST",
    body: JSON.stringify({ params: { sessionId, text: "ping", think: "low", numPredict: 16, provider: "openai" } }),
  });
  if (secPrompt.status !== 200 || secPrompt.body?.ok !== false || secPrompt.body?.lane !== "openai" || !/^model error: .*keychain/.test(secPrompt.body?.reply ?? "") || /no BYOK key/.test(secPrompt.body?.reply ?? "")) {
    fail("an encrypted key on a headless runtime must fail the prompt with the stated reason", secPrompt.body);
  }
  const secRuns = await fetchJson(`/api/runs?sessionId=${encodeURIComponent(sessionId ?? "")}`);
  if (!Array.isArray(secRuns.body) || !secRuns.body.some((r: any) => r.state === "failed" && /keychain/.test(r.error ?? ""))) {
    fail("the durable run record must carry the keychain reason", secRuns.body);
  }
  console.log("[smoke] ok  /api/secrets (headless state reported as-is, refused write, plaintext save labelled, encrypt refused, delete, undecryptable key stated)");

  killTree(child.pid);
  await sleep(1000);
  console.log("[smoke] all checks passed — server killed, tree clean.");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
