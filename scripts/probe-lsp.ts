// Raw LSP probe: spawn typescript-language-server, initialize, didOpen the
// probe file, and dump every notification for 15s. Answers server requests
// minimally. Ground truth for the missing-publishDiagnostics question.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (!args[0] || !args[1]) {
  console.error("usage: tsx scripts/probe-lsp.ts <worktree> <file-relative-to-worktree>");
  process.exit(2);
}
const worktree = args[0];
const filePath = args[1];
const abs = path.join(worktree, filePath);
const text = fs.readFileSync(abs, "utf8");
const uri = pathToFileURL(abs).toString();

const cliArgs = ["node_modules/typescript-language-server/lib/cli.mjs", "--stdio", "--log-level", "4"];
const proc = spawn(process.execPath, cliArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

proc.stderr?.on("data", (c) => { process.stderr.write(String(c).slice(0, 2000)); });
proc.stdout.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    let sep = buffer.indexOf("\r\n\r\n");
    let sepLen = 4;
    if (sep < 0) { sep = buffer.indexOf("\n\n"); sepLen = 2; }
    if (sep < 0) return;
    const headers = buffer.subarray(0, sep).toString("utf8");
    let length = -1;
    for (const line of headers.split(/\r?\n/)) {
      const m = /^content-length\s*:\s*(\d+)\s*$/i.exec(line);
      if (m) length = Number(m[1]);
    }
    const start = sep + sepLen;
    if (length < 0) { buffer = buffer.subarray(start); continue; }
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    dispatch(body);
  }
});

function dispatch(body) {
  let msg;
  try { msg = JSON.parse(body); } catch { return; }
  if (msg.id !== undefined && msg.method) {
    // answer server requests (log them - dynamic registrations matter here)
    console.log(`SERVER-REQUEST ${msg.method} :: ${JSON.stringify(msg.params).slice(0, 300)}`);
    send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }));
    return;
  }
  if (msg.id !== undefined) {
    const p = pending.get(Number(msg.id));
    if (p) { pending.delete(Number(msg.id)); p(msg.error ? { __error: msg.error } : msg.result); }
    return;
  }
  if (msg.method) {
    const u = msg.params?.uri ?? "";
    const dcount = Array.isArray(msg.params?.diagnostics) ? msg.params.diagnostics.length : -1;
    const extra = msg.method === "window/logMessage" ? ` :: ${String(msg.params?.message ?? "").slice(0, 220)}` : "";
    console.log(`NOTIFY ${msg.method} uri=${u} diagnostics=${dcount}${extra}`);
    if (dcount > 0) console.log(JSON.stringify(msg.params.diagnostics[0]).slice(0, 300));
  }
}

function send(s) {
  const body = Buffer.from(s, "utf8");
  proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  proc.stdin.write(body);
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

async function main(): Promise<void> {
  const init = await request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(worktree).toString(),
    rootPath: worktree,
    workspaceFolders: [{ uri: pathToFileURL(worktree).toString(), name: "ehc-playground" }],
    capabilities: {
      textDocument: {
        synchronization: { didSave: true },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
      },
      workspace: { configuration: true, workspaceFolders: true },
    },
  });
  console.log("initialized. server capabilities keys:", Object.keys(init?.capabilities ?? {}).join(","));
  send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
  send(JSON.stringify({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text } } }));
  // VS Code always sends this at startup - some servers gate work on it.
  send(JSON.stringify({ jsonrpc: "2.0", method: "workspace/didChangeConfiguration", params: { settings: {} } }));
  console.log("didOpen + didChangeConfiguration sent:", uri);
  // Wait for the server to settle, then PULL diagnostics (LSP 3.17) and see
  // what comes back - if the server is pull-based, push never arrives.
  setTimeout(async () => {
    try {
      const pulled = await request("textDocument/diagnostic", { textDocument: { uri } });
      console.log("PULL textDocument/diagnostic ->", JSON.stringify(pulled).slice(0, 600));
    } catch (e) {
      console.log("PULL failed:", String(e).slice(0, 300));
    }
  }, 4000);
  // Keep listening long past tsserver warm-up: publishDiagnostics may arrive late.
  setTimeout(() => { proc.kill(); process.exit(0); }, 25000);
}
main().catch((e) => { console.error("probe crashed:", e); process.exit(1); });
