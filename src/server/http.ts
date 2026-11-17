// Event Horizon Code — Local HTTP server (127.0.0.1, Basic auth, stdlib only)
// No Express. Node http. All responses JSON. No telemetry.

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { loadLanguagePacks, lspManager } from "./lsp";
import { runToolchainDoctor } from "./toolchain";
import { detectPackageManager } from "./packageManager";
import { indexSymbols } from "./fallbackIndex";
import { checkSandboxTools, readWorktreeConfig } from "./sandbox";
import { isUnclean } from "./detonate";
import { audit } from "./audit";
import { sweepWorkspace, gateDecision, readAgentWatchConfig, sweepMailbox, snapshotPosture, diffPosture, runProbe, scoreProbe, startOtelReceiver, stopOtelReceiver, acknowledgeFindings, plantCanaries, checkCanaries, detectLoops } from "./agentwatch";
import { subscribe, broadcast } from "./sse";
import { contained } from "./wsguard";
import { getAuditPath, auditHealth } from "./audit";
import { listWorktrees, addWorktree, removeWorktree } from "./worktree";
import { listModels, modelCapabilities } from "./router";
import { searchEngram, verifyArithmetic } from "./engram";
import {
  createSession, listTodos, addTodo, loadMessages,
  listSessionsWithMeta, renameSession, deleteSession,
  listInstructions, putInstruction, removeInstruction,
  usageSummary, listProfiles, upsertProfile, getProfile, deleteProfile,
  forkSession, addCheckpoint, listCheckpoints, messageCount, newSessionId,
} from "./store";
import os from "node:os";
import { runTool, safePath } from "./tools";
import type { ToolName } from "./tools";
import { openTerminal, getTerminal, terminalInput, terminalResize, killTerminal, ptyAvailable, openCommandTerminal, terminalBuffer, waitForTerminalExit } from "./terminal";
import { readEngineConfig, scanGgufDirs, startEngine, stopEngine, engineHealth, engineEndpoint, sensoryDetect, addGgufDir, engineInfill } from "./engine";
import { familyCatalog, detectTemplate, resolveTemplate, templateDir, listTemplateFiles } from "./chatTemplates";
import { runAgentTurn } from "./agentLoop";
import { extractMemories, applyMemories, existingMemoryLines } from "./memory";
import { sensoryStatus, doctor as sensoryDoctor, transcribe } from "./sensory";
import { listVoices, speak, ttsDoctor } from "./tts";
import { listSops, getSop, startRun, getRun, listRuns, approveRun, cancelRun } from "./sop";


export type ServerOpts = { port: number; password: string; host?: string; fatalOnPortConflict?: boolean };

// ACP session state that outlives a single request:
//  - sessionWorktrees: the directory a session operates in (for terminal/create
//    and fs/write_text_file when the client omits cwd).
//  - sessionModes: "default" (ask on write/bash) or "auto" (unattended runs).
//  - cancelledSessions: cooperative cancel - the prompt loop checks between
//    steps; a model call already in flight finishes, then the loop stops.
const sessionWorktrees = new Map<string, string>();
const sessionModes = new Map<string, string>();
const cancelledSessions = new Set<string>();

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

// CORS: dev renderer (localhost:5173) and packaged (file://) are cross-origins to
// the loopback API. Every route requires Basic auth, so reflecting the request
// origin is safe — a hostile page still cannot pass auth.
function setCors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin;
  // Only reflect origins we actually serve: local dev (vite), the app itself,
  // and file:// ("null" origin in some Electron builds). Everything else gets
  // no CORS headers - the browser blocks the response.
  const allowed =
    !origin ||
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    origin === "null";
  if (allowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE, PATCH");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

function checkAuth(req: http.IncomingMessage, password: string, url?: URL): boolean {  // Header first (fetch), then ?auth= query (EventSource cannot send headers).
  const h = req.headers.authorization ?? "";
  if (h.startsWith("Basic ")) {
    try {
      const [, b64] = h.split(" ");
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon < 0) return false;
      const user = decoded.slice(0, colon);
      const pass = decoded.slice(colon + 1);
      if (user !== "eventhorizon") return false;
      // Length check before timingSafeEqual: equal-length inputs only.
      const a = Buffer.from(pass);
      const b = Buffer.from(password);
      if (a.length !== b.length || a.length === 0) return false;
      return crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }
  if (url) {
    // EH-010: single-use event tickets issued to authenticated callers.
    const ticket = url.searchParams.get("ticket") ?? "";
    if (ticket) return consumeEventTicket(ticket);
    const q = url.searchParams.get("auth") ?? "";
    try {
      const a = Buffer.from(q);
      const b = Buffer.from(password);
      if (a.length !== b.length || a.length === 0) return false;
      return crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }
  return false;
}

// Session worktrees may be labels ("default"), not paths - resolve safely so
// tools and language servers never run against a directory that does not exist.
function resolveWorktree(w: string | undefined): string {
  const s = (w ?? "").trim();
  try { return s && fs.existsSync(s) ? s : process.cwd(); } catch { return process.cwd(); }
}

// Active profile id, persisted in .harness/config.json (profile.active) so the
// preference survives restarts. The agent loop applies the same precedence:
// request param > EH_PROFILE > this value > "default".
function readActiveProfile(): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { profile?: { active?: string } };
    return cfg.profile?.active ?? "default";
  } catch { return "default"; }
}

function writeActiveProfile(id: string): void {
  const cfgPath = path.join(process.cwd(), ".harness", "config.json");
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>; } catch { /* fresh config */ }
  raw.profile = { ...(raw.profile as object | undefined), active: id };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
}

// EH-010: single-use event-stream tickets. Issued only to authenticated
// callers, consumed on first use, expired after 60 seconds. The master Basic
// Auth password never appears in an EventSource URL.
const eventTickets = new Map<string, number>();
function issueEventTicket(): string {
  // Lazy purge so the map cannot grow unbounded over long uptimes.
  const now = Date.now();
  if (eventTickets.size > 64) for (const [t, exp] of eventTickets) if (exp <= now) eventTickets.delete(t);
  const t = crypto.randomBytes(24).toString("hex");
  eventTickets.set(t, now + 60_000);
  return t;
}
function consumeEventTicket(t: string): boolean {
  const exp = eventTickets.get(t) ?? 0;
  eventTickets.delete(t);
  return exp > Date.now();
}

export function startHttpServer(opts: ServerOpts): http.Server {
  const host = opts.host ?? "127.0.0.1";
  const packs = loadLanguagePacks();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // EH-003/016: every request body is bounded at ONE entry point. A single
    // byte-count guard covers all per-site "data" listeners; on breach we send
    // 413 and destroy the socket, so no handler ever buffers an oversized body.
    // Slow-loris style requests are cut by the 60s socket timeout.
    let bodyBytes = 0;
    req.on("data", (c: Buffer) => {
      bodyBytes += c.length;
      if (bodyBytes > 4 * 1024 * 1024) {
        try { sendJson(res, 413, { error: "payload too large (4 MiB limit)" }); } catch { /* socket gone */ }
        req.destroy();
      }
    });
    req.setTimeout(60_000, () => {
      try { if (!res.writableEnded) sendJson(res, 408, { error: "request timeout" }); } catch { /* ignore */ }
      req.destroy();
    });

    if (url.pathname === "/global/health") {
      if (!checkAuth(req, opts.password, url)) {
        return sendJson(res, 401, { healthy: false, reason: "unauthorized — Basic auth required (user: eventhorizon, password printed at boot or EH_PASS)" });
      }
      return sendJson(res, 200, { healthy: true, version: "0.1.0" });
    }

    if (!checkAuth(req, opts.password, url)) return sendJson(res, 401, { error: "unauthorized" });

    // EH-010: EventSource cannot send headers, so instead of putting the master
    // password in URLs, authenticated callers exchange it for a single-use,
    // 60-second ticket bound to this runtime.
    if (req.method === "POST" && url.pathname === "/api/events/ticket") {
      const ticket = issueEventTicket();
      return sendJson(res, 200, { ticket });
    }

    if (req.method === "GET" && url.pathname === "/api/toolchain") {
      const checks = await runToolchainDoctor(packs);
      audit({ tool: "toolchain.check", note: `${checks.filter((c) => c.ok).length}/${checks.length}` });
      return sendJson(res, 200, checks);
    }

    if (req.method === "GET" && url.pathname === "/api/languages") {
      return sendJson(res, 200, packs);
    }

    if (req.method === "GET" && url.pathname === "/api/sandbox") {
      const tools = await checkSandboxTools();
      return sendJson(res, 200, tools);
    }

    if (req.method === "GET" && url.pathname === "/api/package-manager") {
      const wt = url.searchParams.get("worktree") ?? process.cwd();
      return sendJson(res, 200, detectPackageManager(wt));
    }

    if (req.method === "GET" && url.pathname === "/api/worktree-config") {
      const wt = url.searchParams.get("worktree") ?? process.cwd();
      return sendJson(res, 200, readWorktreeConfig(wt));
    }

    if (req.method === "POST" && url.pathname === "/api/symbols") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const body = JSON.parse(raw || "{}") as { worktree?: string; ext?: string };
          const symbols = indexSymbols(body.worktree ?? process.cwd(), body.ext ?? ".py");
          audit({ tool: "symbols.index", note: `${symbols.length}` });
          sendJson(res, 200, symbols);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/detonate/check") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const body = JSON.parse(raw || "{}") as { text?: string };
          const unclean = isUnclean(body.text ?? "");
          audit({ tool: "detonate.check", note: unclean ? "unclean" : "clean" });
          sendJson(res, 200, { unclean, route: unclean ? "detonate" : "host" });
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agentwatch/status") {
      return sendJson(res, 200, readAgentWatchConfig());
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/sweep") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { worktree?: string };
          const sweep = await sweepWorkspace(body.worktree ?? process.cwd());
          const gate = gateDecision(sweep);
          audit({ tool: "agentwatch.sweep", note: `${sweep.findings.length} findings allow=${gate.allow}` });
          sendJson(res, 200, { sweep, gate });
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      const wt = url.searchParams.get("worktree") ?? process.cwd();
      return subscribe(wt, res, req.headers.origin);
    }

    // ---- workspace file listing (lazy, one directory per call) ----
    if (req.method === "GET" && url.pathname === "/api/files") {
      const base = resolveWorktree(url.searchParams.get("worktree") ?? undefined);
      const rel = (url.searchParams.get("path") ?? ".").replace(/^[/\\]+/, "");
      // EH-009: the file browser uses the same shared containment guard as the
      // agent tools (sibling-prefix proof + symlink canonicalisation).
      const guard = contained(base, rel);
      if (!guard.ok) return sendJson(res, 400, { error: guard.error ?? "path escapes the workspace" });
      const dir = guard.abs ?? path.resolve(base, rel);
      const SKIP = new Set([".git", "node_modules", "out", "dist", "build", ".eventhorizon", ".harness"]);
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
          .filter((e) => !SKIP.has(e.name) && !e.name.startsWith("."))
          .slice(0, 400)
          .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }))
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
        sendJson(res, 200, { path: rel, entries });
      } catch {
        sendJson(res, 400, { error: "cannot list directory" });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      const models = await listModels();
      return sendJson(res, 200, models);
    }
    // What can this model actually do? Engine /props or Ollama /api/show.
    if (req.method === "GET" && url.pathname === "/api/models/capabilities") {
      const model = url.searchParams.get("model") ?? "";
      const refresh = url.searchParams.get("refresh") === "1";
      return sendJson(res, 200, await modelCapabilities(model, { engineBase: engineEndpoint(), refresh }));
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return sendJson(res, 200, listSessionsWithMeta());
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/sessions/")) {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const id = url.pathname.split("/").pop() ?? "";
          const b = JSON.parse(raw || "{}") as { title?: string };
          if (b.title) { renameSession(id, b.title); audit({ tool: "session.rename", note: id }); }
          sendJson(res, 200, { ok: true });
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
      const id = url.pathname.split("/").pop() ?? "";
      deleteSession(id);
      audit({ tool: "session.delete", note: id });
      return sendJson(res, 200, { ok: true });
    }

    // ---- fork + checkpoints (parallel windows: branch a session, try the
    // other approach, original untouched) ----
    if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/fork")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/fork".length));
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const b = JSON.parse(raw || "{}") as { title?: string; atSeq?: number; checkpointId?: string };
          let atSeq = b.atSeq;
          if (b.checkpointId) {
            const cp = listCheckpoints(id).find((c) => c.ts === b.checkpointId);
            if (!cp) return sendJson(res, 400, { error: "no such checkpoint for this session" });
            atSeq = cp.seq;
          }
          const forked = forkSession(id, { title: b.title, atSeq });
          if (!forked) return sendJson(res, 404, { error: `no such session: ${id}` });
          audit({ tool: "session.fork", note: `${id} -> ${forked.id} atSeq=${atSeq ?? "all"}` });
          sendJson(res, 200, { sessionId: forked.id, title: forked.title, forkedFrom: id });
        } catch (e) {
          const msg = String((e as Error)?.message ?? e).slice(0, 200);
          audit({ tool: "session.fork.error", note: msg });
          sendJson(res, 400, { error: "bad request", cause: msg });
        }
      });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/checkpoints")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/checkpoints".length));
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const b = JSON.parse(raw || "{}") as { label?: string };
          const cp = addCheckpoint(id, messageCount(id), b.label ?? "manual checkpoint");
          audit({ tool: "session.checkpoint", note: `${id} seq=${cp.seq}` });
          sendJson(res, 200, cp);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/checkpoints")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/checkpoints".length));
      return sendJson(res, 200, listCheckpoints(id));
    }
    // Conversation history for a session - the chat column replays this on
    // mount so reopening a window continues the conversation instead of
    // showing an empty pane.
    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/messages")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length, -"/messages".length));
      return sendJson(res, 200, { sessionId: id, messages: loadMessages(id) });
    }

    if (req.method === "GET" && url.pathname === "/api/instructions") {
      const sid = url.searchParams.get("sessionId") ?? "default";
      return sendJson(res, 200, listInstructions(sid));
    }

    if (req.method === "POST" && url.pathname === "/api/instructions") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const b = JSON.parse(raw || "{}") as { sessionId?: string; key?: string; text?: string };
          if (!b.text) return sendJson(res, 400, { error: "text required" });
          putInstruction(b.sessionId ?? "default", b.key ?? `note-${Date.now().toString(36)}`, b.text);
          audit({ tool: "instruction.put", note: b.key ?? "auto" });
          sendJson(res, 200, { ok: true, instructions: listInstructions(b.sessionId ?? "default") });
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/instructions/")) {
      const key = url.pathname.split("/").pop() ?? "";
      const sid = url.searchParams.get("sessionId") ?? "default";
      removeInstruction(sid, key);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/usage") {
      const sid = url.searchParams.get("sessionId") ?? undefined;
      return sendJson(res, 200, usageSummary(sid));
    }

    if (req.method === "GET" && url.pathname === "/api/profiles") {
      return sendJson(res, 200, listProfiles());
    }

    if (req.method === "POST" && url.pathname === "/api/profiles") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const b = JSON.parse(raw || "{}") as { id?: string; name?: string; settings?: Record<string, unknown> };
          const p = upsertProfile({ id: b.id ?? `profile_${Date.now().toString(36)}`, name: b.name ?? "profile", settings: b.settings ?? {}, created: new Date().toISOString() });
          audit({ tool: "profile.upsert", note: p.id });
          sendJson(res, 200, p);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/profiles/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/profiles/".length));
      const existed = deleteProfile(id);
      if (existed && readActiveProfile() === id) {
        writeActiveProfile("default");
        audit({ tool: "profile.active", note: "reset to default after delete" });
      }
      audit({ tool: "profile.delete", note: `${id} existed=${existed}` });
      return sendJson(res, 200, { ok: existed, error: existed ? undefined : "no such profile" });
    }
    if (req.method === "GET" && url.pathname === "/api/profiles/active") {
      return sendJson(res, 200, { id: readActiveProfile() });
    }
    if (req.method === "POST" && url.pathname === "/api/profiles/active") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const b = JSON.parse(raw || "{}") as { id?: string };
          const id = (b.id ?? "default").trim() || "default";
          if (!getProfile(id)) return sendJson(res, 400, { error: `no such profile: ${id}` });
          writeActiveProfile(id);
          audit({ tool: "profile.active", note: id });
          sendJson(res, 200, { id });
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/logs/audit") {
      // Local, redacted-by-construction tail (tool names + notes only).
      // EH-017/019: bounded tail read through the single audit path + health.
      const rawN = Number(url.searchParams.get("n") ?? 100);
      const n = Number.isFinite(rawN) && rawN > 0 ? Math.min(Math.floor(rawN), 500) : 100;
      try {
        const p = getAuditPath();
        const health = auditHealth();
        const st = fs.existsSync(p) ? fs.statSync(p) : null;
        let lines: string[] = [];
        if (st) {
          const span = Math.min(st.size, 512 * 1024); // bounded read, never the whole file
          const fh = fs.openSync(p, "r");
          const buf = Buffer.alloc(span);
          fs.readSync(fh, buf, 0, span, st.size - span);
          fs.closeSync(fh);
          lines = buf.toString("utf8").split("\n").filter(Boolean);
          if (st.size > span) lines.shift(); // drop the possibly-partial first line
        }
        return sendJson(res, 200, { health, entries: lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) });
      } catch { return sendJson(res, 200, { health: auditHealth(), entries: [] }); }
    }

    if (req.method === "GET" && url.pathname === "/api/logs/engine") {
      const n = Math.min(Number(url.searchParams.get("n") ?? 120), 500);
      try {
        const dir = path.join(os.homedir(), ".eventhorizon");
        const logs = fs.readdirSync(dir).filter((f) => f.startsWith("engine-") && f.endsWith(".log")).sort();
        if (!logs.length) return sendJson(res, 200, { log: null, tail: [] });
        const latest = logs[logs.length - 1];
        const tail = fs.readFileSync(path.join(dir, latest), "utf8").trim().split("\n").slice(-n);
        return sendJson(res, 200, { log: latest, tail });
      } catch { return sendJson(res, 200, { log: null, tail: [] }); }
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const body = JSON.parse(raw || "{}") as { title?: string; worktree?: string };
          const s = createSession({ id: newSessionId(), title: body.title ?? "session", worktree: body.worktree ?? process.cwd(), created: new Date().toISOString() });
          audit({ tool: "session.create", note: s.id });
          sendJson(res, 200, s);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/todos") {
      const sid = url.searchParams.get("sessionId") ?? "";
      return sendJson(res, 200, listTodos(sid));
    }

    if (req.method === "POST" && url.pathname === "/api/todos") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const body = JSON.parse(raw || "{}") as { sessionId?: string; text?: string };
          const t = addTodo({ id: `todo_${Date.now().toString(36)}`, sessionId: body.sessionId ?? "", text: body.text ?? "", done: false });
          sendJson(res, 200, t);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/worktrees") {
      const repo = url.searchParams.get("repo") ?? process.cwd();
      return sendJson(res, 200, await listWorktrees(repo));
    }

    if (req.method === "POST" && url.pathname === "/api/worktrees") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { id?: string; branch?: string; repo?: string };
          const r = await addWorktree(body.repo ?? process.cwd(), body.id ?? `wt_${Date.now().toString(36)}`, body.branch ?? `ehc/${Date.now().toString(36)}`);
          audit({ tool: "worktree.add", note: r.path });
          broadcast(r.path, "worktree", { op: "add", path: r.path });
          sendJson(res, 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/engram/search") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { query?: string; topK?: number };
          const r = await searchEngram(body.query ?? "", body.topK ?? 5);
          audit({ tool: "engram.search", note: `${r.records.length}` });
          sendJson(res, 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/engram/verify") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { expr?: string };
          const r = await verifyArithmetic(body.expr ?? "");
          sendJson(res, 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    // ACP-compatible session endpoints (JSON-RPC over HTTP for the desktop client)
    const acpMap: Record<string, string> = {
      "/api/acp/initialize": "initialize",
      "/api/acp/session/new": "session/new",
      "/api/acp/session/prompt": "session/prompt",
      "/api/acp/session/update": "session/update",
      "/api/acp/session/load": "session/load",
      "/api/acp/session/set_mode": "session/set_mode",
      "/api/acp/session/cancel": "session/cancel",
      "/api/acp/session/request_permission": "session/request_permission",
      "/api/acp/fs/read_text_file": "fs/read_text_file",
      "/api/acp/fs/write_text_file": "fs/write_text_file",
      "/api/acp/terminal/create": "terminal/create",
      "/api/acp/terminal/output": "terminal/output",
      "/api/acp/terminal/wait_for_exit": "terminal/wait_for_exit",
      "/api/acp/terminal/kill": "terminal/kill",
      "/api/acp/terminal/release": "terminal/release",
    };
    if (req.method === "POST" && acpMap[url.pathname]) {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { params?: Record<string, unknown> };
          const method = acpMap[url.pathname];
          if (method === "initialize") {
            // Declares what this agent actually supports; a client should not
            // offer UI for anything absent here.
            sendJson(res, 200, {
              protocolVersion: "0.1.0",
              agentCapabilities: {
                loadSession: true,
                promptCapabilities: { image: true, audio: false, embeddedContext: false },
              },
              authMethods: [],
              fs: { read_text_file: true, write_text_file: true },
              terminal: ptyAvailable(),
              modes: ["default", "auto"],
            });
          } else if (method === "session/new") {
            const params = (body.params ?? {}) as { title?: string; worktree?: string };
            const s = createSession({ id: newSessionId(), title: params.title ?? "session", worktree: params.worktree ?? process.cwd(), created: new Date().toISOString() });
            sessionWorktrees.set(s.id, resolveWorktree(params.worktree));
            audit({ tool: "acp.session.new", note: s.id });
            sendJson(res, 200, { sessionId: s.id });
          } else if (method === "session/prompt") {
            const params = (body.params ?? {}) as { sessionId?: string; text?: string; think?: string; model?: string; provider?: string; numPredict?: number; timeoutMs?: number; worktree?: string; images?: string[]; autoApprove?: boolean; profileId?: string; agent?: string };
            audit({ tool: "acp.session.prompt", note: `${params.sessionId ?? ""}:${params.think ?? "default"}:${params.provider ?? "ollama"}:${params.images?.length ?? 0}img${params.autoApprove ? ":auto" : ""}` });
            // Sweep-3 finding 9: autoApprove here is the OPERATOR channel - it
            // originates from the renderer's "auto-approve tools" checkbox and
            // profile config, both set by the credential holder. Anything with
            // this credential already has direct tool-call authority through
            // /api/tools/call, so this parameter does not widen the surface.
            // A server-owned grant system remains a post-alpha item (see
            // docs/AUDIT-432ccfb.md, finding 9).
            // Profile/lane resolution and the bounded tool loop now live in
            // runAgentTurn (src/server/agentLoop.ts) - the same loop that SOP
            // agent nodes and future multi-window agents call.
            // Sweep-3 continuity fix: an omitted worktree means "the session's
            // assigned workspace", never silently the server's cwd.
            const sessionId = params.sessionId ?? "default";
            const existingWorktree = sessionWorktrees.get(sessionId);
            const workdir = params.worktree
              ? resolveWorktree(params.worktree)
              : existingWorktree ?? resolveWorktree(undefined);
            sessionWorktrees.set(sessionId, workdir);
            const turn = await runAgentTurn({
              sessionId,
              text: params.text ?? "",
              workdir,
              think: params.think,
              numPredict: params.numPredict,
              timeoutMs: params.timeoutMs,
              model: params.model,
              provider: params.provider,
              images: params.images,
              autoApprove: params.autoApprove === true || sessionModes.get(sessionId) === "auto",
              agent: params.agent,
              profileId: params.profileId ?? process.env.EH_PROFILE,
              isCancelled: () => cancelledSessions.has(sessionId),
              // Live tokens over SSE: the renderer paints them as they arrive,
              // then replaces the draft with the structured final message.
              onDelta: (delta, kind) => broadcast(workdir, "token", { sessionId, delta, kind: kind ?? "content" }),
            });
            if (turn.model === "none" && !turn.ok) {
              // No model selected - echo + honest hint (never a fake answer).
              const reply = { reply: `echo: ${params.text ?? ""}`, think: params.think ?? "default", hint: turn.error ?? "no model selected - pass params.model (see GET /api/models) or set modelRouter.defaultModel" };
              broadcast(workdir, "session/update", reply);
              sendJson(res, 200, reply);
            } else {
              broadcast(workdir, "session/update", turn);
              sendJson(res, 200, turn);
            }
          } else if (method === "fs/read_text_file") {
            // Sweep-3 critical fix: reads are workspace-contained, credential-
            // protected (safePath), regular-file-only, size-capped and audited.
            const params = (body.params ?? {}) as { path?: string; sessionId?: string };
            const sessionId = params.sessionId ?? "default";
            const worktree = sessionWorktrees.get(sessionId) ?? process.cwd();
            const requestedPath = params.path ?? "";
            if (typeof requestedPath !== "string" || requestedPath.length === 0 || requestedPath.length > 4096) {
              return sendJson(res, 400, { content: "", error: "invalid path" });
            }
            const guard = safePath(worktree, requestedPath);
            if (!guard.ok || !guard.abs) {
              audit({ tool: "acp.fs.read", note: `blocked path=${requestedPath.slice(0, 120)}` });
              return sendJson(res, 403, { content: "", error: guard.error ?? "path outside workspace" });
            }
            try {
              const stat = fs.statSync(guard.abs);
              if (!stat.isFile()) return sendJson(res, 400, { content: "", error: "not a regular file" });
              if (stat.size > 200_000) return sendJson(res, 413, { content: "", error: "file exceeds the 200 KB ACP read limit" });
              const text = fs.readFileSync(guard.abs, "utf8");
              audit({ tool: "acp.fs.read", note: `${requestedPath.slice(0, 120)} bytes=${stat.size}` });
              return sendJson(res, 200, { content: text });
            } catch (error) {
              audit({ tool: "acp.fs.read", note: `read failed: ${String(error).slice(0, 120)}` });
              return sendJson(res, 404, { content: "", error: "read failed" });
            }
          } else if (method === "session/load") {
            // Resume a session: history + durable instructions + todos, so an
            // ACP client (or a new window) picks up exactly where it left off.
            const params = (body.params ?? {}) as { sessionId?: string };
            const sid = params.sessionId ?? "default";
            audit({ tool: "acp.session.load", note: sid });
            sendJson(res, 200, {
              sessionId: sid,
              messages: loadMessages(sid),
              instructions: listInstructions(sid),
              todos: listTodos(sid),
            });
          } else if (method === "session/set_mode") {
            // Session modes: "default" (ask on write/bash) or "auto" (unattended).
            const params = (body.params ?? {}) as { sessionId?: string; mode?: string };
            const mode = params.mode === "auto" ? "auto" : "default";
            sessionModes.set(params.sessionId ?? "default", mode);
            audit({ tool: "acp.session.mode", note: `${params.sessionId ?? ""}:${mode}` });
            sendJson(res, 200, { sessionId: params.sessionId ?? "default", mode });
          } else if (method === "session/cancel") {
            // Cooperative cancellation: the prompt loop checks between steps.
            const params = (body.params ?? {}) as { sessionId?: string };
            cancelledSessions.add(params.sessionId ?? "default");
            audit({ tool: "acp.session.cancel", note: params.sessionId ?? "" });
            sendJson(res, 200, { ok: true, note: "cancel requested - applies between agent steps" });
          } else if (method === "fs/write_text_file") {
            const params = (body.params ?? {}) as { path?: string; content?: string; sessionId?: string };
            const critical = isUnclean(path.basename(params.path ?? "") + " " + (params.path ?? ""));
            if (critical) {
              sendJson(res, 200, { content: "", error: "blocked: unclean path requires detonate lane", critical: true });
              return;
            }
            const worktree = sessionWorktrees.get(params.sessionId ?? "default") ?? process.cwd();
            // ACP fs/write is user-initiated through the session - never auto-approved.
            const r = await runTool("write", { path: params.path ?? "", content: params.content ?? "" }, worktree);
            audit({ tool: "acp.fs.write", note: `${params.path ?? ""} ok=${r.ok}` });
            sendJson(res, 200, r.needsApproval ? { needsApproval: true, error: r.error } : { ok: r.ok, error: r.error });
          } else if (method === "terminal/create") {
            // ACP terminal: run a specific command in a PTY, not a shell.
            // Sweep-3: arbitrary execution over the HTTP API is DISABLED by
            // default - possessing the local credential must not equal blanket
            // execute permission. Operators opt in with EH_ACP_TERMINAL=1.
            const params = (body.params ?? {}) as { sessionId?: string; cwd?: string; command?: string; args?: string[]; env?: Array<{ name?: string; value?: string }>; output_byte_limit?: number };
            if (process.env.EH_ACP_TERMINAL !== "1") {
              audit({ tool: "acp.terminal.create", note: "blocked: terminal execution disabled (set EH_ACP_TERMINAL=1 to enable)" });
              sendJson(res, 403, { error: "ACP terminal execution is disabled (set EH_ACP_TERMINAL=1 to enable)" });
              return;
            }
            const cmd = params.command ?? "";
            const cmdText = `${cmd} ${(params.args ?? []).join(" ")}`;
            if (isUnclean(cmdText)) {
              audit({ tool: "acp.terminal.create", note: "blocked unclean command" });
              sendJson(res, 200, { error: "blocked: unclean command requires the detonate lane", critical: true });
              return;
            }
            const cwd = resolveWorktree(params.cwd || sessionWorktrees.get(params.sessionId ?? ""));
            const env: Record<string, string> = {};
            for (const e of params.env ?? []) if (e.name) env[e.name] = e.value ?? "";
            const r = ptyAvailable()
              ? openCommandTerminal(cwd, cmd, params.args ?? [], { outputByteLimit: params.output_byte_limit, env })
              : { ok: false, error: "node-pty native module unavailable - ACP terminals disabled (stated blind spot)" };
            audit({ tool: "acp.terminal.create", note: `${cmd.slice(0, 60)} ok=${r.ok}` });
            if (!r.ok) return sendJson(res, 200, r);
            if (params.sessionId) sessionWorktrees.set(params.sessionId, cwd);
            sendJson(res, 200, { terminalId: (r as { id?: string }).id, cwdNote: (r as { cwdNote?: string }).cwdNote });
          } else if (method === "terminal/output") {
            const params = (body.params ?? {}) as { terminalId?: string };
            const t = terminalBuffer(params.terminalId ?? "");
            sendJson(res, 200, t.ok
              ? { output: t.output, truncated: t.truncated, exit_code: t.exit_code, signal: t.signal }
              : { error: t.error });
          } else if (method === "terminal/wait_for_exit") {
            const params = (body.params ?? {}) as { terminalId?: string; timeoutMs?: number };
            const t = await waitForTerminalExit(params.terminalId ?? "", params.timeoutMs ?? 0);
            sendJson(res, 200, t.ok
              ? { exit_code: t.exit_code, signal: t.signal }
              : { error: t.error });
          } else if (method === "terminal/kill" || method === "terminal/release") {
            const params = (body.params ?? {}) as { terminalId?: string };
            const ok = killTerminal(params.terminalId ?? "");
            audit({ tool: `acp.terminal.${method.split("/")[1]}`, note: `${params.terminalId ?? ""} ok=${ok}` });
            sendJson(res, 200, { ok });
          } else if (method === "session/request_permission") {
            // Advisory-only protocol shim (ACP clients drive this). Nothing in
            // this server treats the echoed decision as execution authority:
            // since the EH-007 fix, runTool authorization comes exclusively
            // from opts.userApproved, which this endpoint cannot grant.
            const params = (body.params ?? {}) as { tool?: string; approved?: boolean };
            audit({ tool: "acp.permission", note: `advisory ${params.tool ?? ""}:${params.approved === true}` });
            sendJson(res, 200, { approved: params.approved === true });
          } else {
            sendJson(res, 200, { type: method, ok: true });
          }
        } catch (e) {
          // A swallowed ACP error looks like "bad request" to the client with no
          // way to debug it - state the cause in the audit log and on stderr.
          const msg = String((e as Error)?.message ?? e).slice(0, 200);
          audit({ tool: "acp.error", note: `${acpMap[url.pathname] ?? url.pathname}: ${msg}` });
          console.error(`[ehc] acp ${url.pathname} failed: ${msg}`);
          sendJson(res, 400, { error: "bad request", cause: msg });
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tools/call") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { tool?: ToolName; args?: Record<string, unknown>; worktree?: string };
          // The HTTP caller is the user's renderer: an approved flag HERE is the
          // user's Review-pane decision. The model's own arguments never reach
          // this endpoint with authority (runTool strips args.approved anyway).
          const userApproved = (body.args as { approved?: boolean } | undefined)?.approved === true;
          const result = await runTool(body.tool ?? "read", body.args ?? {}, body.worktree ?? process.cwd(), { userApproved });
          sendJson(res, 200, result);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/mailbox") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { mailboxDir?: string };
          const sweep = await sweepMailbox(body.mailboxDir);
          const gate = gateDecision(sweep);
          audit({ tool: "agentwatch.mailbox", note: `${sweep.findings.length} findings allow=${gate.allow}` });
          sendJson(res, 200, { sweep, gate });
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/posture/snapshot") {
      const r = await snapshotPosture();
      audit({ tool: "agentwatch.posture.snapshot", note: r.baseline });
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/posture/diff") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { baseline?: string };
          const r = await diffPosture(body.baseline);
          audit({ tool: "agentwatch.posture.diff", note: `${r.diff.length} diffs` });
          sendJson(res, 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/probe/run") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { pack?: string; targetUrl?: string; model?: string; arm?: string };
          const r = await runProbe(body.pack ?? "agentic_v1", body.targetUrl ?? "http://127.0.0.1:8012", body.model ?? "local", body.arm ?? "a");
          audit({ tool: "agentwatch.probe.run", note: r.pack });
          sendJson(res, 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/probe/score") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { scoresFile?: string; ref?: string };
          const r = await scoreProbe(body.scoresFile ?? "a.jsonl", body.ref ?? "a");
          audit({ tool: "agentwatch.probe.score", note: r.pack });
          sendJson(res, 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/otel/start") {
      const r = await startOtelReceiver();
      audit({ tool: "agentwatch.otel.start", note: r.note });
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/otel/stop") {
      const r = stopOtelReceiver();
      audit({ tool: "agentwatch.otel.stop", note: r.note });
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/acknowledge") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { entries?: Array<{ rule: string; file: string }>; action?: "approve" | "clean" | "detonate" };
          const r = acknowledgeFindings(body.entries ?? [], body.action ?? "approve");
          audit({ tool: "agentwatch.acknowledge", note: `${r.count} entries` });
          sendJson(res, 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/canary/plant") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { dir?: string; count?: number };
          const r = await plantCanaries(body.dir ?? path.join(process.cwd(), ".eventhorizon", "vault"), body.count ?? 3);
          audit({ tool: "agentwatch.canary.plant", note: r.note.slice(0, 80) });
          sendJson(res, 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agentwatch/canary/check") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { dir?: string; registry?: string };
          const r = await checkCanaries(body.dir ?? path.join(process.cwd(), ".eventhorizon", "vault"), body.registry ?? path.join(process.cwd(), ".eventhorizon", "vault"));
          audit({ tool: "agentwatch.canary.check", note: r.ok ? "checked" : "failed" });
          sendJson(res, 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agentwatch/loops") {
      const r = await detectLoops();
      audit({ tool: "agentwatch.loops", note: `${r.loops.length}` });
      return sendJson(res, 200, r);
    }

    // PTY terminal: open, stream (SSE), input, resize, kill
    if (url.pathname.startsWith("/api/terminal/")) {
      if (req.method === "POST" && url.pathname === "/api/terminal/open") {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          try {
            const body = JSON.parse(raw || "{}") as { worktree?: string };
            const r = openTerminal(body.worktree ?? process.cwd());
            sendJson(res, r.ok ? 200 : 503, r);
          } catch { sendJson(res, 400, { error: "bad request" }); }
        });
        return;
      }
      const parts = url.pathname.split("/").filter(Boolean); // api terminal <id> <action>
      if (parts.length >= 4) {
        const id = parts[2];
        const action = parts[3];
        if (req.method === "GET" && action === "stream") {
          const s = getTerminal(id);
          if (!s) return sendJson(res, 404, { error: "no such terminal" });
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": req.headers.origin ?? "*" });
          const onData = (d: string) => { try { res.write(`data: ${JSON.stringify({ d })}\n\n`); } catch { /* client gone */ } };
          s.pty.onData(onData);
          s.pty.onExit(() => { try { res.write("event: exit\ndata: {}\n\n"); res.end(); } catch { /* closed */ } });
          const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25000);
          res.on("close", () => clearInterval(ping));
          return;
        }
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          try {
            const body = JSON.parse(raw || "{}") as { data?: string; cols?: number; rows?: number };
            if (action === "input") { sendJson(res, terminalInput(id, String(body.data ?? "")) ? 200 : 404, { ok: true }); return; }
            if (action === "resize") { sendJson(res, terminalResize(id, Number(body.cols ?? 80), Number(body.rows ?? 24)) ? 200 : 404, { ok: true }); return; }
            if (action === "kill") { sendJson(res, killTerminal(id) ? 200 : 404, { ok: true }); return; }
            sendJson(res, 404, { error: "not found" });
          } catch { sendJson(res, 400, { error: "bad request" }); }
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/terminal/status") {
        return sendJson(res, 200, { ptyAvailable: ptyAvailable() });
      }
    }

    // Bundled engine (chonkllama.cpp sidecar): status, model scan, start/stop
    if (req.method === "GET" && url.pathname === "/api/engine/status") {
      return sendJson(res, 200, { config: readEngineConfig(), ...(await engineHealth()) });
    }
    // ---- LSP: real language servers per worktree (diagnostics, hover, definition) ----
    // Server lifecycle is manager-owned: lazily spawned, idle-reaped, killed with the harness.
    const lspBody = (cb: (b: { worktree?: string; path?: string; text?: string; version?: number; line?: number; character?: number }) => void) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { cb(JSON.parse(raw || "{}")); } catch { sendJson(res, 400, { error: "bad request" }); }
      });
    };
    if (req.method === "POST" && url.pathname === "/api/lsp/open") {
      lspBody(async (b) => {
        const r = await lspManager.openDocument(resolveWorktree(b.worktree), b.path ?? "", b.text ?? "", b.version ?? 1);
        audit({ tool: "lsp.open", note: `${b.path ?? ""} ok=${r.ok}${r.error ? ` ${r.error.slice(0, 80)}` : ""}` });
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lsp/change") {
      lspBody(async (b) => {
        const r = await lspManager.changeDocument(resolveWorktree(b.worktree), b.path ?? "", b.text ?? "", b.version);
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lsp/close") {
      lspBody(async (b) => {
        const r = await lspManager.closeDocument(resolveWorktree(b.worktree), b.path ?? "");
        sendJson(res, 200, r);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lsp/diagnostics") {
      lspBody(async (b) => {
        const r = await lspManager.diagnosticsFor(resolveWorktree(b.worktree), b.path ?? "");
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lsp/hover") {
      lspBody(async (b) => {
        const r = await lspManager.hover(resolveWorktree(b.worktree), b.path ?? "", b.line ?? 0, b.character ?? 0);
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/lsp/definition") {
      lspBody(async (b) => {
        const r = await lspManager.definition(resolveWorktree(b.worktree), b.path ?? "", b.line ?? 0, b.character ?? 0);
        sendJson(res, r.ok ? 200 : 400, r);
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/lsp/status") {
      return sendJson(res, 200, { servers: lspManager.status(), packs: loadLanguagePacks().map((p) => ({ id: p.id, tier: p.tier, lsp: p.lsp.command[0], extensions: p.fileExtensions.slice(0, 6) })) });
    }
    if (req.method === "POST" && url.pathname === "/api/lsp/kill") {
      lspBody((b) => {
        const wt = resolveWorktree(b.worktree);
        if (b.path) lspManager.kill(wt, b.path); else lspManager.killWorktree(wt);
        audit({ tool: "lsp.kill", note: `${b.path ?? wt}` });
        sendJson(res, 200, { ok: true });
      });
      return;
    }

    // ---- auto-memory: propose from a session, operator approves ----
    if (req.method === "GET" && url.pathname === "/api/memory") {
      const wt = resolveWorktree(url.searchParams.get("worktree") ?? undefined);
      return sendJson(res, 200, { path: path.join(wt, ".harness", "memory.md"), lines: existingMemoryLines(wt) });
    }
    if (req.method === "POST" && url.pathname === "/api/memory/extract") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const b = JSON.parse(raw || "{}") as { sessionId?: string; worktree?: string; model?: string };
          const r = await extractMemories(b.sessionId ?? "default", resolveWorktree(b.worktree), { model: b.model });
          sendJson(res, 200, r);
        } catch (e) {
          sendJson(res, 400, { error: "bad request", cause: String((e as Error)?.message ?? e).slice(0, 200) });
        }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/memory/apply") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const b = JSON.parse(raw || "{}") as { worktree?: string; texts?: string[] };
          const r = applyMemories(resolveWorktree(b.worktree), b.texts ?? []);
          sendJson(res, 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    // ---- SOPs: repeatable workflows of agent / script / human-gate nodes ----
    // Adapted from Tencent LoopForge (MIT). Mode preference: "gated" (human
    // gates pause for approval) or "automated" (unattended: gates auto-approve,
    // agent tool calls auto-approve). Precedence: run > SOP file > config.
    if (req.method === "GET" && url.pathname === "/api/sops") {
      return sendJson(res, 200, {
        defaultMode: ((): string => { try { const c = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { sop?: { defaultMode?: string } }; return c.sop?.defaultMode ?? "gated"; } catch { return "gated"; } })(),
        sops: listSops().map((s) => ({
          name: s.name, description: s.description, mode: s.mode ?? "gated",
          nodes: s.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, role: n.role, onFail: n.onFail, note: n.note })),
        })),
      });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/sops/") && url.pathname.endsWith("/run")) {
      const name = decodeURIComponent(url.pathname.slice("/api/sops/".length, -"/run".length));
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const b = JSON.parse(raw || "{}") as { worktree?: string; sessionId?: string; mode?: string; task?: string };
          const worktree = resolveWorktree(b.worktree);
          const r = startRun(name, { worktree, sessionId: b.sessionId, mode: b.mode, task: b.task });
          if (!r.ok) return sendJson(res, 400, r);
          sendJson(res, 200, { runId: r.run!.id, mode: r.run!.mode, status: r.run!.status });
        } catch (e) {
          const msg = String((e as Error)?.message ?? e).slice(0, 200);
          audit({ tool: "sop.run.error", note: msg });
          sendJson(res, 400, { error: "bad request", cause: msg });
        }
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sops/runs") {
      return sendJson(res, 200, listRuns().map((r) => ({ id: r.id, sop: r.sop, mode: r.mode, status: r.status, currentNode: r.currentNode, started: r.started, error: r.error })));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/sops/runs/")) {
      const run = getRun(decodeURIComponent(url.pathname.slice("/api/sops/runs/".length)));
      return run ? sendJson(res, 200, run) : sendJson(res, 404, { error: "no such run" });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/sops/runs/") && url.pathname.endsWith("/approve")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sops/runs/".length, -"/approve".length));
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const b = JSON.parse(raw || "{}") as { approved?: boolean; sendBackTo?: string };
          const r = await approveRun(id, b);
          sendJson(res, r.ok ? 200 : 400, r.run ? { ok: true, status: r.run.status, currentNode: r.run.currentNode, error: r.run.error } : r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/sops/runs/") && url.pathname.endsWith("/cancel")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sops/runs/".length, -"/cancel".length));
      const r = cancelRun(id);
      return sendJson(res, r.ok ? 200 : 400, r.run ? { ok: true, status: r.run.status } : r);
    }

    // ---- text to speech (adapter-based: system voices / engine / piper) ----
    if (req.method === "GET" && url.pathname === "/api/tts/voices") {
      return sendJson(res, 200, listVoices());
    }
    if (req.method === "GET" && url.pathname === "/api/tts/doctor") {
      return sendJson(res, 200, ttsDoctor());
    }
    if (req.method === "POST" && url.pathname === "/api/tts/speak") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const b = JSON.parse(raw || "{}") as { text?: string; voice?: string; adapter?: string };
          const r = await speak(b.text ?? "", { voice: b.voice, adapter: b.adapter as never });
          sendJson(res, r.ok ? 200 : 200, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    // ---- sensory sidecars: ears (STT) + mouth (TTS), honest about absence ----
    if (req.method === "GET" && url.pathname === "/api/sensory/status") {
      return sendJson(res, 200, sensoryStatus());
    }
    if (req.method === "GET" && url.pathname === "/api/sensory/doctor") {
      return sendJson(res, 200, sensoryDoctor());
    }
    if (req.method === "POST" && url.pathname === "/api/sensory/transcribe") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const b = JSON.parse(raw || "{}") as { audioBase64?: string; language?: string };
          if (!b.audioBase64) return sendJson(res, 400, { error: "audioBase64 (16 kHz mono WAV) required" });
          const r = await transcribe(b.audioBase64, { language: b.language });
          sendJson(res, r.ok ? 200 : 400, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sensory/speak") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const b = JSON.parse(raw || "{}") as { text?: string };
          if (!b.text?.trim()) return sendJson(res, 400, { error: "text required" });
          const r = await speak(b.text.slice(0, 4000));
          sendJson(res, r.ok ? 200 : 400, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/engine/templates") {
      // The vendored canonical template set (from llama.cpp, MIT) plus the
      // family detection for a given model. Powers the engine picker UI.
      const model = url.searchParams.get("model") ?? "";
      return sendJson(res, 200, {
        dir: templateDir(),
        families: familyCatalog(),
        files: listTemplateFiles(),
        detected: model ? (detectTemplate(model) ?? null) : null,
        resolved: model ? (resolveTemplate("auto", model) ?? null) : null,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/engine/infill") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const b = JSON.parse(raw || "{}") as { input_prefix?: string; input_suffix?: string; max_tokens?: number; temperature?: number };
          const r = await engineInfill(b);
          audit({ tool: "engine.infill", note: `ok=${r.ok}` });
          sendJson(res, r.ok ? 200 : 400, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/engine/models") {
      const cfg = readEngineConfig();
      return sendJson(res, 200, scanGgufDirs(cfg.ggufDirs));
    }
    if (req.method === "POST" && url.pathname === "/api/engine/models/dirs") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const body = JSON.parse(raw || "{}") as { dir?: string };
          if (!body.dir) return sendJson(res, 400, { error: "dir required" });
          const r = addGgufDir(body.dir);
          audit({ tool: "engine.models.dir", note: `${body.dir} ok=${r.ok}` });
          sendJson(res, r.ok ? 200 : 400, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/engine/start") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const b = JSON.parse(raw || "{}") as { ggufPath?: string; heapFraction?: number; deviceIndex?: number | null; pool?: boolean; extraArgs?: string[]; mmprojPath?: string; ctx?: number; chatTemplate?: string };
          const r = await startEngine(b.ggufPath, { heapFraction: b.heapFraction, deviceIndex: b.deviceIndex, pool: b.pool, extraArgs: b.extraArgs, mmprojPath: b.mmprojPath, ctx: b.ctx, chatTemplate: b.chatTemplate });
          audit({ tool: "engine.start", note: r.note.slice(0, 120) });
          sendJson(res, r.ok ? 200 : 400, r);
        } catch { sendJson(res, 400, { error: "bad request" }); }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/engine/stop") {
      const r = stopEngine();
      audit({ tool: "engine.stop", note: r.note });
      return sendJson(res, 200, r);
    }
    if (req.method === "GET" && url.pathname === "/api/engine/sensory") {
      const s = sensoryDetect();
      audit({ tool: "engine.sensory", note: `eyes=${s.eyes} ears=${s.ears} mouth=${s.mouth}` });
      return sendJson(res, 200, s);
    }

    return sendJson(res, 404, { error: "not found" });
  });

  server.listen(opts.port, host, () => {
    if (process.env.EH_DEBUG === "1") console.log(`[ehc] http listening on http://${host}:${opts.port}`);
    server.emit("ehc-listening");
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (opts.fatalOnPortConflict === false) {
      // Embedded runtime: the shell retries on another port - never exit the app.
      server.emit("ehc-listen-error", err);
      return;
    }
    if (err.code === "EADDRINUSE") {
      console.error(`[ehc] FATAL: port ${opts.port} already in use — a stale instance is likely holding it.`);
      console.error(`[ehc] Find it:  Get-NetTCPConnection -LocalPort ${opts.port} -State Listen | Select-Object OwningProcess`);
      console.error(`[ehc] Kill it:  Stop-Process -Id <pid>   (or pick another port: EH_PORT)`);
    } else {
      console.error(`[ehc] server error: ${err.message}`);
    }
    process.exit(1);
  });
  return server;
}
