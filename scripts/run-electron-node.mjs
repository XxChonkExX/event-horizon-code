// scripts/run-electron-node.mjs — run a script inside Electron's embedded Node.
// Why: better-sqlite3 v12 is ABI-specific. electron-rebuild targets Electron's ABI,
// so plain `node` can no longer load it. ELECTRON_RUN_AS_NODE gives us Electron's
// ABI with pure-Node semantics — both the GUI and headless share one binary set.
// (Same resolution OpenCode Desktop made: server inside Electron's runtime.)
//
// Usage: node scripts/run-electron-node.mjs <script.js> [args...]
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronBin = require("electron"); // npm package exports the binary path in Node

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("[ehc] usage: node scripts/run-electron-node.mjs <script> [args...]");
  process.exit(1);
}

const child = spawn(electronBin, args, {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
// Forward Ctrl+C so the server shuts down cleanly.
process.on("SIGINT", () => { try { child.kill("SIGINT"); } catch { /* ignore */ } });
