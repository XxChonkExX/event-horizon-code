// Event Horizon Code — MCP client (stdio, newline-delimited JSON-RPC 2.0)
// Servers are spawned as child processes with an env allowlist; tools are
// namespaced mcp_<server>_<tool> and merged into the agent's tool set.
// Process hygiene: every child tracked and killed on stop/exit — no orphans.
//
// Config (.harness/config.json):
//   "mcp": { "servers": { "files": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","."], "env": {} } } }
// Env values (and command/args) may reference the BYOK keychain:
//   "env": { "GITHUB_TOKEN": "${secrets:github}" }   -> resolved at start
// A missing or unreadable secret fails the start with the reason.

import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { audit } from "./audit";
import { hasSecretRefs, resolveSecretRefs } from "./secrets";

export type McpToolDef = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

class McpServer {
  name: string;
  private proc: ChildProcess | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private tools: McpToolDef[] = [];
  private ready = false;

  constructor(name: string, private cfg: { command: string; args?: string[]; env?: Record<string, string> }) {
    this.name = name;
  }

  async start(timeoutMs = 15000): Promise<void> {
    if (this.proc) return;
    const { command, args, env: resolvedEnv, referenced } = resolveMcpLaunch(this.cfg);
    if (referenced.length) audit({ tool: "mcp.secrets", note: `${this.name} <- ${referenced.join(",")}` });
    const proc = spawn(command, args, {
      // Env allowlist: pass PATH/HOME/system basics, plus the server's own vars.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        ...resolvedEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout?.on("data", (d: Buffer) => this.onData(d.toString()));
    proc.stderr?.on("data", () => { /* servers log freely; ignore */ });
    proc.on("exit", () => {
    // Sweep-3: exit/startup failure settles every outstanding request exactly
    // once - pending promises must never hang until their timeout fires.
    this.proc = null;
    this.ready = false;
    this.rejectPending(new Error(`${this.name}: server process exited`));
  });
  proc.on("error", (err: Error) => {
    this.proc = null;
    this.ready = false;
    this.rejectPending(new Error(`${this.name}: ${err.message}`));
  });
    const init = await (async () => {
      try {
        return await this.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "event-horizon-code", version: "0.1.0" },
        }, timeoutMs);
      } catch (e) {
        // External audit: an init failure must TEAR THE CHILD DOWN. The spawn
        // previously survived unregistered, and a retry leaked a second process.
        this.failServer(e instanceof Error ? e : new Error(String(e)));
        throw e;
      }
    })();
    if (!init) throw new Error(`${this.name}: initialize failed`);
    this.notify("notifications/initialized", {});
    let listed: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } | null;
    try {
      listed = (await this.request("tools/list", {}, timeoutMs)) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } | null;
    } catch (e) {
      this.failServer(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
    this.tools = (listed?.tools ?? []).map((t) => ({
      type: "function" as const,
      function: {
        name: `mcp_${this.name}_${t.name}`,
        description: `[mcp:${this.name}] ${t.description ?? t.name}`,
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    }));
    this.ready = true;
    audit({ tool: "mcp.start", note: `${this.name} tools=${this.tools.length}` });
  }

  private onData(chunk: string) {
    // Sweep-3: input is bounded - a runaway or hostile server cannot grow the
    // buffer without limit, and any single JSON-RPC line over 1 MiB fails the
    // server rather than feeding garbage into the parser.
    this.buf += chunk;
    if (Buffer.byteLength(this.buf, "utf8") > 2 * 1024 * 1024) {
      this.failServer(new Error(`${this.name}: MCP input buffer exceeded limit`));
      return;
    }
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
        this.failServer(new Error(`${this.name}: MCP JSON-RPC line exceeded limit`));
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(trimmed) as typeof msg; } catch { continue; }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "mcp error"));
        else p.resolve(msg.result);
      }
    }
  }

  // Settle every outstanding request exactly once, then tear the server down.
  private rejectPending(reason: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
  }

  private failServer(reason: Error) {
    this.ready = false;
    this.rejectPending(reason);
    const proc = this.proc;
    this.proc = null;
    try { proc?.kill(); } catch { /* may already be dead */ }
  }

  private send(obj: unknown) {
    this.proc?.stdin?.write(JSON.stringify(obj) + "\n");
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 20000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name}: ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  getTools(): McpToolDef[] { return this.ready ? this.tools : []; }

  async call(toolName: string, args: Record<string, unknown>): Promise<{ ok: boolean; out: string }> {
    const bare = toolName.replace(`mcp_${this.name}_`, "");
    const r = (await this.request("tools/call", { name: bare, arguments: args }, 60000)) as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | null;
    const text = (r?.content ?? []).map((c) => c.text ?? "").join("\n").slice(0, 20000);
    audit({ tool: "mcp.call", note: `${this.name}.${bare} isError=${r?.isError ?? false}` });
    return { ok: !(r?.isError ?? false), out: text };
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch { /* already dead */ } this.proc = null; this.ready = false; }
  }
}

// Turn a configured server (command/args/env) into the values actually
// spawned: "${secrets:*}" references resolved through the BYOK keychain at
// start (tokens live sealed in secrets.json, never in config.json or a log),
// executable-resolution env keys blocked, oversized values dropped. Exported
// for tests. A missing or unreadable referenced secret THROWS - the start
// fails with the reason; a server must not launch with a blank token.
export function resolveMcpLaunch(cfg: { command: string; args?: string[]; env?: Record<string, string> }): {
  command: string; args: string[]; env: Record<string, string>; referenced: string[];
} {
  const BLOCKED_MCP_ENV = new Set(["PATH", "PATHEXT", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]);
  const referenced = new Set<string>();
  const res = (v: string): string => {
    if (!hasSecretRefs(v)) return v;
    for (const m of v.matchAll(/\$\{secrets:([A-Za-z0-9_-]{1,32})/g)) referenced.add(m[1]);
    return resolveSecretRefs(v);
  };
  const env: Record<string, string> = {};
  for (const [k, raw] of Object.entries(cfg.env ?? {})) {
    if (BLOCKED_MCP_ENV.has(k.toUpperCase()) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof raw !== "string") continue;
    const v = res(raw);
    if (v.length <= 8192) env[k] = v;
  }
  return { command: res(cfg.command), args: (cfg.args ?? []).map(res), env, referenced: [...referenced].sort() };
}

const servers = new Map<string, McpServer>();
const starting = new Map<string, Promise<void>>();

function readMcpConfig(): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { mcp?: { servers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> } };
    return raw.mcp?.servers ?? {};
  } catch { return {}; }
}

export function hasMcpServers(): boolean { return Object.keys(readMcpConfig()).length > 0; }

// Start all configured servers (idempotent, concurrent).
export async function ensureMcpServers(): Promise<void> {
  const cfg = readMcpConfig();
  await Promise.all(Object.entries(cfg).map(async ([name, c]) => {
    if (servers.has(name)) return;
    if (starting.has(name)) return starting.get(name);
    const s = new McpServer(name, c);
    const p = s.start().then(() => { servers.set(name, s); }).catch((e) => { audit({ tool: "mcp.start.fail", note: `${name}: ${String(e).slice(0, 160)}` }); }).finally(() => starting.delete(name));
    starting.set(name, p);
    return p;
  }));
}

export function mcpTools(): McpToolDef[] {
  return Array.from(servers.values()).flatMap((s) => s.getTools());
}

export function isMcpTool(name: string): boolean { return name.startsWith("mcp_"); }

export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; out: string }> {
  const server = Array.from(servers.values()).find((s) => s.getTools().some((t) => t.function.name === name));
  if (!server) return { ok: false, out: `no MCP server owns tool ${name}` };
  try { return await server.call(name, args); }
  catch (e) { return { ok: false, out: `mcp call failed: ${String(e).slice(0, 200)}` }; }
}

export function stopAllMcp() {
  for (const s of servers.values()) s.stop();
  servers.clear();
}

process.on("exit", stopAllMcp);
