// Event Horizon Code — Local HTTP server (127.0.0.1, Basic auth, stdlib only)
// No Express. Node http. All responses JSON. No telemetry.

import http from "node:http";
import crypto from "node:crypto";
import { loadLanguagePacks } from "./lsp";
import { runToolchainDoctor } from "./toolchain";
import { detectPackageManager } from "./packageManager";
import { indexSymbols } from "./fallbackIndex";
import { checkSandboxTools, readWorktreeConfig } from "./sandbox";
import { isUnclean } from "./detonate";
import { audit } from "./audit";
import { sweepWorkspace, gateDecision, readAgentWatchConfig } from "./agentwatch";

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

    return sendJson(res, 404, { error: "not found" });
  });

  server.listen(opts.port, host, () => {
    if (process.env.EH_DEBUG === "1") console.log(`[ehc] http listening on http://${host}:${opts.port}`);
  });
  return server;
}
