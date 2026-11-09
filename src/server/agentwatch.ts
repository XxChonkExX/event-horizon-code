// Event Horizon Code — AgentWatch integration (opt-in, deterministic line-manager)
// Default OFF. When off: no subprocess, no gating. When on: local sweep, operator review paramount.
//
// Integration surface:
//   - AgentWatch: https://github.com/XxChonkExX/AgentWatch (MIT, stdlib Python, http localhost)
//   - EHC reads config: enabled=false means fully inert. lineManager=true means block edit/bash until reviewed.
//
// No LLM judge. Lane A (deterministic) may condemn. Lane B may only rank. User is final arbiter.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type AgentWatchConfig = {
  enabled: boolean;
  lineManager: boolean;
  ledgerDir: string;
};

export type SweepFinding = { rule: string; sev: string; file: string };

export type SweepResult = {
  ok: boolean;
  enabled: boolean;
  findings: SweepFinding[];
  coverage: string;
  limits: string;
  ledger: string;
};

export function readAgentWatchConfig(): AgentWatchConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as {
      agentwatch?: { enabled?: boolean; lineManager?: boolean; ledgerDir?: string };
    };
    return {
      enabled: raw.agentwatch?.enabled ?? false,
      lineManager: raw.agentwatch?.lineManager ?? false,
      ledgerDir: raw.agentwatch?.ledgerDir ?? path.join(process.cwd(), ".eventhorizon", "aw-ledger"),
    };
  } catch {
    return { enabled: false, lineManager: false, ledgerDir: ".eventhorizon/aw-ledger" };
  }
}

// Deterministic workspace check. Only runs when enabled. Light: filesystem sweep, stdlib Python.
export function sweepWorkspace(worktree: string): Promise<SweepResult> {
  const cfg = readAgentWatchConfig();
  if (!cfg.enabled) {
    return Promise.resolve({ ok: true, enabled: false, findings: [], coverage: "disabled (opt-in off)", limits: "", ledger: cfg.ledgerDir });
  }

  // AgentWatch CLI is stdlib-only, no GPU, local. Command is a subprocess; timeout capped.
  return new Promise((resolve) => {
    const args = ["sweep", worktree, "--ledger", cfg.ledgerDir, "--json"];
    execFile("aw", args, { timeout: 15000, maxBuffer: 500000 }, (err, stdout) => {
      if (err) {
        // Scanner absent is a stated blind spot, never a silent pass.
        // Tell operator to run `pip install -e .` in AgentWatch or check PATH.
        resolve({
          ok: false,
          enabled: true,
          findings: [],
          coverage: "scanner unavailable — blind spot stated",
          limits: String((err as Error).message).slice(0, 200),
          ledger: cfg.ledgerDir,
        });
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout)) as { findings?: SweepFinding[] };
        resolve({
          ok: true,
          enabled: true,
          findings: Array.isArray(parsed.findings) ? parsed.findings : [],
          coverage: "agentwatch sweep",
          limits: "",
          ledger: cfg.ledgerDir,
        });
      } catch {
        resolve({ ok: false, enabled: true, findings: [], coverage: "parse error", limits: "stdout was not valid JSON", ledger: cfg.ledgerDir });
      }
    });
  });
}

// Gate decision. Deterministic guide; operator review paramount.
// - If disabled: allow (no gating)
// - If enabled but lineManager off: allow but flag for UI badge ("review recommended")
// - If enabled + lineManager on + high/critical unreviewed: block edit/bash until Approve/Clean/Detonate clicked
export type GateDecision = { allow: boolean; reason: string; findings: SweepFinding[] };

export function gateDecision(sweep: SweepResult): GateDecision {
  if (!sweep.enabled) return { allow: true, reason: "AgentWatch opt-in off", findings: [] };
  if (!sweep.ok) return { allow: false, reason: "sweep failed — scanner blind spot — operator must review", findings: sweep.findings };
  const bad = sweep.findings.filter((f) => f.sev === "high" || f.sev === "critical");
  if (bad.length === 0) return { allow: true, reason: "clean — operator may proceed", findings: sweep.findings };
  const cfg = readAgentWatchConfig();
  if (cfg.lineManager) return { allow: false, reason: `${bad.length} high/critical finding(s) — line-manager blocking until operator review`, findings: sweep.findings };
  return { allow: true, reason: `${bad.length} high/critical finding(s) — flagged for review, not blocking (lineManager off)`, findings: sweep.findings };
}

// Phase B: mailbox sweep (agent-to-agent email mirror) + runtime posture diff.
// Opt-in only, same gate rules.

export type MailboxSweepResult = SweepResult & { mailboxDir: string };
export type PostureResult = { ok: boolean; enabled: boolean; backend: string; baseline: string; diff: string[] };

export function sweepMailbox(mailboxDir?: string): Promise<MailboxSweepResult> {
  const cfg = readAgentWatchConfig();
  const dir = mailboxDir ?? path.join(process.cwd(), ".eventhorizon", "mail");
  if (!cfg.enabled) {
    return Promise.resolve({ ok: true, enabled: false, findings: [], coverage: "disabled (opt-in off)", limits: "", ledger: cfg.ledgerDir, mailboxDir: dir });
  }
  if (!fs.existsSync(dir)) {
    return Promise.resolve({ ok: true, enabled: true, findings: [], coverage: "mailbox dir missing — stated blind spot", limits: dir, ledger: cfg.ledgerDir, mailboxDir: dir });
  }
  return new Promise((resolve) => {
    execFile("aw", ["sweep", dir, "--ledger", cfg.ledgerDir, "--json"], { timeout: 15000, maxBuffer: 500000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, enabled: true, findings: [], coverage: "scanner unavailable — blind spot stated", limits: String((err as Error).message).slice(0, 200), ledger: cfg.ledgerDir, mailboxDir: dir });
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout)) as { findings?: SweepFinding[] };
        resolve({ ok: true, enabled: true, findings: parsed.findings ?? [], coverage: "mailbox sweep", limits: "", ledger: cfg.ledgerDir, mailboxDir: dir });
      } catch {
        resolve({ ok: false, enabled: true, findings: [], coverage: "parse error", limits: "stdout not JSON", ledger: cfg.ledgerDir, mailboxDir: dir });
      }
    });
  });
}

export function snapshotPosture(outPath?: string): Promise<PostureResult> {
  const cfg = readAgentWatchConfig();
  if (!cfg.enabled) {
    return Promise.resolve({ ok: true, enabled: false, backend: "none", baseline: "", diff: [] });
  }
  const baseline = outPath ?? path.join(cfg.ledgerDir, "baseline.json");
  fs.mkdirSync(path.dirname(baseline), { recursive: true });
  return new Promise((resolve) => {
    execFile("aw", ["snapshot", "--out", baseline], { timeout: 20000, maxBuffer: 500000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, enabled: true, backend: "unavailable", baseline, diff: [String((err as Error).message).slice(0, 200)] });
        return;
      }
      // Backend is recorded in the snapshot file itself; we report what the CLI printed.
      resolve({ ok: true, enabled: true, backend: "agentwatch", baseline, diff: [String(stdout).slice(0, 200)] });
    });
  });
}

export function diffPosture(baselinePath?: string): Promise<PostureResult> {
  const cfg = readAgentWatchConfig();
  if (!cfg.enabled) {
    return Promise.resolve({ ok: true, enabled: false, backend: "none", baseline: "", diff: [] });
  }
  const baseline = baselinePath ?? path.join(cfg.ledgerDir, "baseline.json");
  if (!fs.existsSync(baseline)) {
    return Promise.resolve({ ok: true, enabled: true, backend: "aw", baseline, diff: ["no baseline yet — run snapshot first (stated blind spot until then)"] });
  }
  return new Promise((resolve) => {
    execFile("aw", ["posture", "--baseline", baseline, "--json"], { timeout: 20000, maxBuffer: 500000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, enabled: true, backend: "aw", baseline, diff: [String((err as Error).message).slice(0, 200)] });
        return;
      }
      let diff: string[] = [];
      try {
        const parsed = JSON.parse(String(stdout)) as { findings?: SweepFinding[] };
        diff = (parsed.findings ?? []).map((f) => `${f.sev} ${f.rule} ${f.file}`);
      } catch { diff = [String(stdout).slice(0, 500)]; }
      resolve({ ok: true, enabled: true, backend: "aw", baseline, diff });
    });
  });
}
