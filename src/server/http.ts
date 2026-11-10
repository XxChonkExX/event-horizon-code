// Event Horizon Code — Local HTTP server (127.0.0.1, Basic auth, stdlib only)
// No Express. Node http. All responses JSON. No telemetry.

import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { loadLanguagePacks } from "./lsp";
import { runToolchainDoctor } from "./toolchain";
import { detectPackageManager } from "./packageManager";
import { indexSymbols } from "./fallbackIndex";
import { checkSandboxTools, readWorktreeConfig } from "./sandbox";
import { isUnclean } from "./detonate";
import { audit } from "./audit";
import { sweepWorkspace, gateDecision, readAgentWatchConfig, sweepMailbox, snapshotPosture, diffPosture, runProbe, scoreProbe, startOtelReceiver, stopOtelReceiver, acknowledgeFindings, plantCanaries, checkCanaries, detectLoops } from "./agentwatch";
import { subscribe, broadcast } from "./sse";
import { listWorktrees, addWorktree, removeWorktree } from "./worktree";
import { listModels, chat, chatOpenAI } from "./router";
import type { ChatResult } from "./router";
import { searchEngram, verifyArithmetic } from "./engram";
import { listSessions, createSession, listTodos, addTodo } from "./store";
import { runTool } from "./tools";
import type { ToolName } from "./tools";
import { openTerminal, getTerminal, terminalInput, terminalResize, killTerminal, ptyAvailable } from "./terminal";

export type ServerOpts = { port: number; password: string; host?: string };

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
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

function readConfigDefaultModel(): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { modelRouter?: { defaultModel?: string | null } };
    return cfg.modelRouter?.defaultModel ?? null;
  } catch { return null; }
}

// BYOK secrets — .harness/secrets.json (gitignored). Shape:
// { "openai": { "baseUrl": "https://opencode.ai/inference/openai/v1", "apiKey": "oc_..." } }
function readSecret(provider: string): { baseUrl?: string; apiKey?: string } | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "secrets.json"), "utf8")) as Record<string, { baseUrl?: string; apiKey?: string }>;
    return s[provider] ?? null;
  } catch { return null; }
}

export function startHttpServer(opts: ServerOpts): http.Server {
  const host = opts.host ?? "127.0.0.1";
  const packs = loadLanguagePacks();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");

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
      return subscribe(wt, res);
    }

    if (req.method === "GET" && url.pathname === "/api/models") {
      const models = await listModels();
      return sendJson(res, 200, models);
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return sendJson(res, 200, listSessions());
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try {
          const body = JSON.parse(raw || "{}") as { title?: string; worktree?: string };
          const s = createSession({ id: `ses_${Date.now().toString(36)}`, title: body.title ?? "session", worktree: body.worktree ?? process.cwd(), created: new Date().toISOString() });
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
      "/api/acp/session/request_permission": "session/request_permission",
      "/api/acp/fs/read_text_file": "fs/read_text_file",
    };
    if (req.method === "POST" && acpMap[url.pathname]) {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(raw || "{}") as { params?: Record<string, unknown> };
          const method = acpMap[url.pathname];
          // Minimal live behavior: initialize echoes version, session/new creates a session row, prompt broadcasts via SSE, others stub.
          if (method === "initialize") {
            sendJson(res, 200, { protocolVersion: "0.1.0", capabilities: { fs: ["read_text_file"] } });
          } else if (method === "session/new") {
            const params = (body.params ?? {}) as { title?: string; worktree?: string };
            const s = createSession({ id: `ses_${Date.now().toString(36)}`, title: params.title ?? "session", worktree: params.worktree ?? process.cwd(), created: new Date().toISOString() });
            audit({ tool: "acp.session.new", note: s.id });
            sendJson(res, 200, { sessionId: s.id });
          } else if (method === "session/prompt") {
            const params = (body.params ?? {}) as { sessionId?: string; text?: string; think?: string; model?: string; provider?: string; numPredict?: number; timeoutMs?: number; worktree?: string };
            audit({ tool: "acp.session.prompt", note: `${params.sessionId ?? ""}:${params.think ?? "default"}:${params.provider ?? "ollama"}` });
            // BYOK lane: provider "openai" speaks OpenAI-compatible (OpenCode Console gateway, OpenAI, OpenRouter, vLLM).
            let result: ChatResult | null = null;
            const usedModel = params.model ?? readConfigDefaultModel() ?? "";
            if (params.provider === "openai") {
              const secret = readSecret("openai");
              if (!secret?.apiKey || !secret.baseUrl) {
                result = { ok: false, content: "", model: usedModel || "openai", error: "no BYOK key - put {\"openai\":{\"baseUrl\",\"apiKey\"}} in .harness/secrets.json (gitignored)" };
              } else {
                result = await chatOpenAI(usedModel || "gpt-4o-mini", [{ role: "user", content: params.text ?? "" }], { baseUrl: secret.baseUrl, apiKey: secret.apiKey, think: params.think ?? "medium", numPredict: params.numPredict, timeoutMs: params.timeoutMs });
              }
            } else if (usedModel) {
              result = await chat(usedModel, [{ role: "user", content: params.text ?? "" }], { think: params.think ?? "medium", numPredict: params.numPredict, timeoutMs: params.timeoutMs });
            }
            if (result) {
              audit({ tool: "model.chat", note: `${result.model} tokens=${result.tokens ?? "?"} ok=${result.ok}` });
              const reply = { reply: result.ok ? result.content : `model error: ${result.error}`, thinking: result.thinking, model: result.model, tokens: result.tokens, think: params.think ?? "medium" };
              broadcast(params.worktree ?? process.cwd(), "session/update", reply);
              sendJson(res, 200, reply);
            } else {
              // No model selected — echo + honest hint (never a fake answer).
              const reply = { reply: `echo: ${params.text ?? ""}`, think: params.think ?? "default", hint: "no model selected - pass params.model (see GET /api/models) or set modelRouter.defaultModel" };
              broadcast(params.worktree ?? process.cwd(), "session/update", reply);
              sendJson(res, 200, reply);
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
          } else if (method === "session/request_permission") {
            const params = (body.params ?? {}) as { tool?: string; approved?: boolean };
            // In real UI the frontend prompts the operator. Server records the decision.
            audit({ tool: "acp.permission", note: `${params.tool ?? ""}:${params.approved === true}` });
            sendJson(res, 200, { approved: params.approved === true });
          } else {
            sendJson(res, 200, { type: method, ok: true });
          }
        } catch { sendJson(res, 400, { error: "bad request" }); }
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
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          const onData = (d: string) => { try { res.write(`data: ${JSON.stringify(d)}\n\n`); } catch { /* client gone */ } };
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
