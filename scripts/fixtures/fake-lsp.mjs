// Fake language server for testing the EHC LSP plumbing without installing a
// real one. Speaks LSP over stdio with Content-Length framing:
//   - answers initialize / shutdown / hover
//   - sends a server->client request (client/registerCapability) after
//     initialize and records the client's reply in a marker file
//   - publishes diagnostics on didOpen and didChange
// Marker file path comes from FAKE_LSP_MARKER (used by scripts/test-lsp.ts).
//
// FAKE_LSP_MODE selects the diagnostics behavior:
//   "push" (default): pushes on didOpen/didChange, using a WINDOWS-MANGLED URI
//     (file:///c%3A/... lowercase drive, encoded colon) exactly like real
//     typescript-language-server - exercises the client's URI normalization.
//   "pull": never pushes; answers textDocument/diagnostic with a full report -
//     exercises the client's LSP 3.17 pull path.

import fs from "node:fs";

let buffer = Buffer.alloc(0);
let shutdown = false;
const marker = process.env.FAKE_LSP_MARKER ?? "";
const mode = process.env.FAKE_LSP_MODE ?? "push";

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
// Real Windows servers (typescript-language-server) percent-encode the drive
// colon and lowercase it; simulate that so URI-keying bugs surface on any OS.
function mangleUri(uri) {
  return mode === "push" ? uri.replace(/^file:\/\/\/([A-Za-z]):/, (_m, d) => `file:///${d.toLowerCase()}%3A`) : uri;
}
function publish(uri, message) {
  notify("textDocument/publishDiagnostics", {
    uri: mangleUri(uri),
    diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message, source: "fake-lsp" }],
  });
}

function handle(msg) {
  const { id, method, params } = msg;
  // A response to our server->client request: record it and stop.
  if (id !== undefined && method === undefined) {
    if (marker) { try { fs.writeFileSync(marker, `registered:${JSON.stringify(msg.result ?? null)}`); } catch { /* ignore */ } }
    return;
  }
  switch (method) {
    case "initialize":
      reply(id, { capabilities: { textDocumentSync: 1, hoverProvider: true } });
      // Exercise the server->client request path: the client must answer.
      send({ jsonrpc: "2.0", id: "reg1", method: "client/registerCapability", params: { registrations: [] } });
      break;
    case "initialized":
      break;
    case "shutdown":
      shutdown = true;
      reply(id, null);
      break;
    case "exit":
      process.exit(0);
      break;
    case "textDocument/didOpen":
      if (mode === "push") publish(params.textDocument.uri, `fake: opened ${params.textDocument.uri} (${params.textDocument.text.length} chars)`);
      break;
    case "textDocument/didChange":
      if (mode === "push") publish(params.textDocument.uri, `fake: changed v${params.textDocument.version} (${params.contentChanges[0]?.text.length ?? 0} chars)`);
      break;
    case "textDocument/diagnostic":
      if (mode === "pull") reply(id, { kind: "full", items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "fake: pulled", source: "fake-lsp" }] });
      else reply(id, { __lspError: { code: -32601, message: "Unhandled method textDocument/diagnostic" } });
      break;
    case "textDocument/hover":
      reply(id, { contents: { kind: "plaintext", value: "fake hover" } });
      break;
    case "textDocument/definition":
      reply(id, { uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
      break;
    default:
      if (id !== undefined) reply(id, null);
  }
}

process.stdin.on("data", (chunk) => {
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
    try { handle(JSON.parse(body)); } catch { /* bad frame - skip */ }
  }
});
