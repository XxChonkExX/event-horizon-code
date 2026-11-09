// Event Horizon Code — Local HTTP server (127.0.0.1, Basic auth, stdlib only)
// No Express. Node http. All responses JSON. No telemetry.

import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { loadLanguagePacks } from "./lsp";
import { runToolchainDoctor } from "./toolchain";
import { detectPackageManager } from "./packageManager";
import { indexSymbols } from "./fallbackIndex";
import { checkSandboxTools, readWorktreeConfig } from "./sandbox";
import { isUnclean } from "./detonate";
import { audit } from "./audit";
import { sweepWorkspace, gateDecision, readAgentWatchConfig } from "./agentwatch";
import { subscribe, broadcast } from "./sse";
import { listWorktrees, addWorktree, removeWorktree } from "./worktree";
import { listModels } from "./router";
import { searchEngram, verifyArithmetic } from "./engram";
import { listSessions, createSession, listTodos, addTodo } from "./store";
import { runTool } from "./tools";
import type { ToolName } from "./tools";

export type ServerOpts = { port: number; password: string; host?: string };

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function checkAuth(req: http.IncomingMessage, password: string): boolean {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Basic ")) return false;
  const [, b64] = h.split(" ");
  try {
    const [user, pass] = Buffer.from(b64, "base64").toString("utf8").split(":");
    return user === "eventhorizon" && crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(password));
  } catch { return false; }
}

export function startHttpServer(opts: ServerOpts): http.Server {
  const host = opts.host ?? "127.0.0.1";
  const packs = loadLanguagePacks();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");

    if (url.pathname === "/global/health") {
      if (!checkAuth(req, opts.password)) return sendJson(res, 401, { healthy: false });
      return sendJson(res, 200, { healthy: true, version: "0.1.0" });
    }

    if (!checkAuth(req, opts.password)) return sendJson(res, 401, { error: "unauthorized" });

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
            const params = (body.params ?? {}) as { sessionId?: string; text?: string; think?: string; worktree?: string };
            audit({ tool: "acp.session.prompt", note: `${params.sessionId ?? ""}:${params.think ?? "default"}` });
            // Echo back and broadcast to windows (SSE)
            const reply = { reply: `echo: ${params.text ?? ""}`, think: params.think ?? "default" };
            broadcast(params.worktree ?? process.cwd(), "session/update", reply);
            sendJson(res, 200, reply);
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

    return sendJson(res, 404, { error: "not found" });
  });

  server.listen(opts.port, host, () => {
    if (process.env.EH_DEBUG === "1") console.log(`[ehc] http listening on http://${host}:${opts.port}`);
  });
  return server;
}
