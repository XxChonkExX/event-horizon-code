// Event Horizon Code — MCP client (stdio, newline-delimited JSON-RPC 2.0)
// Servers are spawned as child processes with an env allowlist; tools are
// namespaced mcp_<server>_<tool> and merged into the agent's tool set.
// Process hygiene: every child tracked and killed on stop/exit — no orphans.
//
// Config (.harness/config.json):
//   "mcp": { "servers": { "files": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","."], "env": {} } } }

import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { audit } from "./audit";

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
    const proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      // Env allowlist: pass PATH/HOME/system basics, plus the server's own vars.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        ...(this.cfg.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout?.on("data", (d: Buffer) => this.onData(d.toString()));
    proc.stderr?.on("data", () => { /* servers log freely; ignore */ });
    proc.on("exit", () => { this.proc = null; this.ready = false; });
    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "event-horizon-code", version: "0.1.0" },
    }, timeoutMs);
    if (!init) throw new Error(`${this.name}: initialize failed`);
    this.notify("notifications/initialized", {});
    const listed = (await this.request("tools/list", {}, timeoutMs)) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> } | null;
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
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(line) as typeof msg; } catch { continue; }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "mcp error"));
        else p.resolve(msg.result);
      }
    }
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
