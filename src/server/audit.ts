// Event Horizon Code — Audit log
// Appends to ~/.eventhorizon/audit.jsonl. One JSON object per line.
// No PII beyond session ids and tool names. Secrets never logged.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function auditPath(): string {
  const base = process.env.EH_AUDIT_LOG ?? path.join(os.homedir(), ".eventhorizon", "audit.jsonl");
  return base;
}

export type AuditEntry = {
  ts: string;
  session?: string;
  agent?: string;
  tool: string;
  argsHash?: string;
  model?: string;
  cost?: number;
  note?: string;
};

export function audit(entry: Omit<AuditEntry, "ts"> & { ts?: string }) {
  const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
  try {
    const p = auditPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(full) + "\n", "utf8");
  } catch {
    // Audit failure never blocks the agent. Log to stderr.
    console.error("[ehc][audit] failed to write");
  }
  if (process.env.EH_DEBUG === "1") console.log("[ehc][audit]", full.tool);
}
