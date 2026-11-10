// Event Horizon Code — Headless runtime server
// Boots the local HTTP server without Electron. For smoke tests and CLI-driven use.
// Run: npm run serve   (EH_PORT, EH_PASS to override)
//
// Process hygiene: Ctrl+C or kill the PID to stop. Nothing daemonizes, nothing persists.

import crypto from "node:crypto";
import { startLocalServer } from "../src/server/index";

const port = Number(process.env.EH_PORT ?? 4126);
const password = process.env.EH_PASS ?? crypto.randomBytes(12).toString("hex");

process.on("SIGINT", () => { console.log("\n[ehc] shutting down"); process.exit(0); });
process.on("SIGTERM", () => { process.exit(0); });

async function main() {
  await startLocalServer({ port, password });

  console.log(`[ehc] runtime up:  http://127.0.0.1:${port}`);
  console.log(`[ehc] health:      curl -u eventhorizon:${password} http://127.0.0.1:${port}/global/health`);
  console.log(`[ehc] models:      curl -u eventhorizon:${password} http://127.0.0.1:${port}/api/models`);
  console.log(`[ehc] stop:        kill this process (Ctrl+C) — no orphans left behind`);
}

main().catch((e) => { console.error("[ehc] fatal:", e); process.exit(1); });

// Hold the event loop open; the http server keeps it alive anyway.
setInterval(() => {}, 1 << 30);
