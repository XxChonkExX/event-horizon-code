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
import { listWorktrees, addWorktree, removeWorktree } from "./worktree";
import { listModels } from "./router";
import { searchEngram, verifyArithmetic } from "./engram";
import {
  createSession, listTodos, addTodo, loadMessages,
  listSessionsWithMeta, renameSession, deleteSession,
  listInstructions, putInstruction, removeInstruction,
  usageSummary, listProfiles, upsertProfile, getProfile, deleteProfile,
  forkSession, addCheckpoint, listCheckpoints, messageCount, newSessionId,
} from "./store";
import os from "node:os";
import { runTool } from "./tools";
import type { ToolName } from "./tools";
import { openTerminal, getTerminal, terminalInput, terminalResize, killTerminal, ptyAvailable, openCommandTerminal, terminalBuffer, waitForTerminalExit } from "./terminal";
import { readEngineConfig, scanGgufDirs, startEngine, stopEngine, engineHealth, sensoryDetect, addGgufDir, engineInfill } from "./engine";
import { familyCatalog, detectTemplate, resolveTemplate, templateDir, listTemplateFiles } from "./chatTemplates";
import { runAgentTurn } from "./agentLoop";
import { listSops, getSop, startRun, getRun, listRuns, approveRun, cancelRun } from "./sop";


export type ServerOpts = { port: number; password: string; host?: string };

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
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

function checkAuth(req: http.IncomingMessage, password: string, url?: URL): boolean {  // Header first (fetch), then ?auth= query (EventSource cannot send headers).
  const h = req.headers.authorization ?? "";
  if (h.startsWith("Basic ")) {
    try {
      const [, b64] = h.split(" ");
      const [user, pass] = Buffer.from(b64, "base64").toString("utf8").split(":");
      return user === "eventhorizon" && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(password));
    } catch { return false; }
  }
  if (url) {
    const q = url.searchParams.get("auth") ?? "";
    try { return q.length > 0 && crypto.timingSafeEqual(Buffer.from(q), Buffer.from(password)); } catch { return false; }
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

    if (url.pathname === "/global/health") {
      if (!checkAuth(req, opts.password, url)) {
        return sendJson(res, 401, { healthy: false, reason: "unauthorized — Basic auth required (user: eventhorizon, password printed at boot or EH_PASS)" });
      }
      return sendJson(res, 200, { healthy: true, version: "0.1.0" });
    }

    if (!checkAuth(req, opts.password, url)) return sendJson(res, 401, { error: "unauthorized" });

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

    if (req.method === "GET" && url.pathname === "/api/models") {
      const models = await listModels();
      return sendJson(res, 200, models);
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
      const n = Math.min(Number(url.searchParams.get("n") ?? 100), 500);
      try {
        const p = path.join(os.homedir(), ".eventhorizon", "audit.jsonl");
        const lines = fs.readFileSync(p, "utf8").trim().split("\n");
        return sendJson(res, 200, lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }));
      } catch { return sendJson(res, 200, []); }
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
            // Profile/lane resolution and the bounded tool loop now live in
            // runAgentTurn (src/server/agentLoop.ts) - the same loop that SOP
            // agent nodes and future multi-window agents call.
            const workdir = resolveWorktree(params.worktree);
            const sessionId = params.sessionId ?? "default";
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
            const params = (body.params ?? {}) as { path?: string };
            const critical = isUnclean(path.basename(params.path ?? "") + " " + (params.path ?? ""));
            if (critical) {
              sendJson(res, 200, { content: "", error: "blocked: unclean path requires detonate lane", critical: true });
              return;
            }
            // Language packs gate reads to workspace in full implementation; here read file.
            try {
              const text = (await import("node:fs")).readFileSync(params.path ?? "", "utf8");
              sendJson(res, 200, { content: text.slice(0, 200000) });
            } catch {
              sendJson(res, 200, { content: "", error: "read failed" });
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
            const r = await runTool("write", { path: params.path ?? "", content: params.content ?? "", approved: false }, worktree);
            audit({ tool: "acp.fs.write", note: `${params.path ?? ""} ok=${r.ok}` });
            sendJson(res, 200, r.needsApproval ? { needsApproval: true, error: r.error } : { ok: r.ok, error: r.error });
          } else if (method === "terminal/create") {
            // ACP terminal: run a specific command in a PTY, not a shell.
            const params = (body.params ?? {}) as { sessionId?: string; cwd?: string; command?: string; args?: string[]; env?: Array<{ name?: string; value?: string }>; output_byte_limit?: number };
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
            const params = (body.params ?? {}) as { tool?: string; approved?: boolean };
            // In real UI the frontend prompts the operator. Server records the decision.
            audit({ tool: "acp.permission", note: `${params.tool ?? ""}:${params.approved === true}` });
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
          const result = await runTool(body.tool ?? "read", body.args ?? {}, body.worktree ?? process.cwd());
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
      req.on("end", () => {
        try {
          const b = JSON.parse(raw || "{}") as { approved?: boolean; sendBackTo?: string };
          const r = approveRun(id, b);
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
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
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
