// LSP plumbing smoke test - runs the real LspManager against a fake language
// server (scripts/fixtures/fake-lsp.mjs) so Content-Length framing, the
// initialize handshake, didOpen/didChange, publishDiagnostics forwarding,
// hover, and the server->client request path are all exercised.
//
// No real language server needs to be installed. Run: npm run lsp:test

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LspManager } from "../src/server/lsp";
import type { LanguagePack } from "../src/server/lsp";

const fixture = path.resolve("scripts/fixtures/fake-lsp.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-lsp-"));
const srcDir = path.join(tmp, "src");
fs.mkdirSync(srcDir, { recursive: true });
const fileRel = "src/main.fake";
const fileAbs = path.join(srcDir, "main.fake");
const marker = path.join(tmp, "marker.txt");
fs.writeFileSync(fileAbs, "let x = 1;\n");
process.env.FAKE_LSP_MARKER = marker;

const pack: LanguagePack = {
  id: "fake",
  displayName: "Fake",
  tier: 99,
  fileExtensions: [".fake"],
  toolchain: { check: [] },
  lsp: { command: ["node", fixture] },
  dap: { command: [] },
  formatter: { command: [] },
  linter: { command: [] },
  commands: { build: "", test: "", run: "" },
  treeSitter: { grammar: "fake" },
  engramPack: "",
  skill: "",
};

const mgr = new LspManager([pack]);
process.on("exit", () => mgr.killAllSync());

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const seen: Array<{ lang: string; diagnostics: unknown[] }> = [];
mgr.onDiagnostics = (_wt, lang, payload) => {
  const p = payload as { diagnostics?: unknown[] };
  seen.push({ lang, diagnostics: p.diagnostics ?? [] });
};

function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timeout waiting for ${what}`)); }
    }, 25);
  });
}

async function main(): Promise<void> {
  console.log("[ehc] lsp smoke test");

  // 1. open -> handshake + didOpen + publishDiagnostics
  const open = await mgr.openDocument(tmp, fileRel, "let x = 1;\n", 1);
  check("open ok", open.ok === true, open.error ?? "");
  check("open detected language", open.lang === "fake");
  await until(() => seen.length >= 1, 8000, "first publishDiagnostics");
  check("diagnostics forwarded", seen.length >= 1 && seen[0].lang === "fake");
  check("diagnostic content", JSON.stringify(seen[0]?.diagnostics ?? []).includes("fake: opened"));

  // 2. change -> new diagnostics
  const change = await mgr.changeDocument(tmp, fileRel, "let x = 42;\n", 2);
  check("change ok", change.ok === true, change.error ?? "");
  await until(() => seen.length >= 2, 8000, "second publishDiagnostics");
  check("change diagnostics", JSON.stringify(seen[1]?.diagnostics ?? []).includes("fake: changed v2"));

  // 3. hover round trip
  const hover = await mgr.hover(tmp, fileRel, 0, 4);
  check("hover ok", hover.ok === true, hover.error ?? "");
  check("hover content", JSON.stringify(hover.result ?? {}).includes("fake hover"));

  // 4. definition round trip
  const def = await mgr.definition(tmp, fileRel, 0, 4);
  check("definition ok", def.ok === true, def.error ?? "");

  // 5. server->client request was answered (marker file written by the fixture)
  await until(() => fs.existsSync(marker), 8000, "server request response marker");
  check("server->client request answered", fs.existsSync(marker), "fixture never saw our reply");

  // 6. diagnostics query for an open file
  const diag = await mgr.diagnosticsFor(tmp, fileRel, 3000);
  check("diagnosticsFor ok", diag.ok === true && Array.isArray(diag.diagnostics));

  // 7. status + graceful shutdown
  const status = mgr.status();
  check("status lists server", status.length === 1 && status[0].lang === "fake" && status[0].initialized);
  mgr.kill(tmp, "fake");
  await until(() => mgr.status().length === 0, 6000, "server exit after kill");
  check("kill reaps server", mgr.status().length === 0);

  // 8. unknown extension states plainly
  const unknown = await mgr.openDocument(tmp, "notes.unknownext", "x");
  check("unknown extension refused", unknown.ok === false && !!unknown.error);

  console.log(failures === 0 ? "[ehc] lsp smoke test: ALL PASS" : `[ehc] lsp smoke test: ${failures} FAILURE(S)`);
  mgr.killAllSync();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[ehc] lsp smoke test crashed:", e);
  mgr.killAllSync();
  process.exit(1);
});
