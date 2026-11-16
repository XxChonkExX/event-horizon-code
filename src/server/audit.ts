// Event Horizon Code - Audit log
// Appends to ~/.eventhorizon/audit.jsonl (or EH_AUDIT_LOG). One JSON object per
// line. No PII beyond session ids and tool names; notes are shape metadata, not
// raw command text. Failures never crash the agent, but the last failure is
// retained for /api/audit health reporting.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Single source of truth for the audit location (EH-017): writer, viewer and
// rotation all use this. EH_AUDIT_LOG is honoured consistently.
export function getAuditPath(): string {
  return process.env.EH_AUDIT_LOG ?? path.join(os.homedir(), ".eventhorizon", "audit.jsonl");
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

// Audit health: visible failure state, not a silent swallow (EH-006).
let lastError: { at: string; message: string } | null = null;
const ROTATE_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded(p: string): void {
  try {
    const st = fs.statSync(p);
    if (st.size > ROTATE_BYTES) {
      // Keep exactly one generation (audit.jsonl.1); oldest data ages out.
      fs.renameSync(p, p + ".1");
    }
  } catch { /* nothing to rotate */ }
}

export function auditHealth(): { ok: boolean; path: string; lastError: { at: string; message: string } | null; bytes: number } {
  const p = getAuditPath();
  let bytes = 0;
  try { bytes = fs.statSync(p).size; } catch { /* not written yet */ }
  return { ok: lastError === null, path: p, lastError, bytes };
}

export function audit(entry: Omit<AuditEntry, "ts"> & { ts?: string }) {
  const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
  try {
    const p = getAuditPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    rotateIfNeeded(p);
    fs.appendFileSync(p, JSON.stringify(full) + "\n", "utf8");
  } catch (e) {
    // Audit failure never blocks the agent, but the reason is retained and
    // visible through /api/audit (disk-full, permission-denied, ...).
    lastError = { at: new Date().toISOString(), message: String((e as Error)?.message ?? e).slice(0, 160) };
    console.error(`[ehc][audit] write failed: ${lastError.message}`);
  }
  if (process.env.EH_DEBUG === "1") console.log("[ehc][audit]", full.tool);
}
