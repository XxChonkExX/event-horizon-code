// Event Horizon Code — AgentWatch panel (opt-in, deterministic line-manager)
// Default OFF. When ON: run workspace/mailbox sweep, posture diff, show findings, operator clicks Approve / Clean / Detonate.
// No LLM judge. Lane A deterministic. User is final arbiter. Phase B: mailbox + posture.

import { createSignal } from "solid-js";

type SweepFinding = { rule: string; sev: string; file: string };

export default function AgentWatchPanel() {
  const [enabled, setEnabled] = createSignal(false);
  const [lineMgr, setLineMgr] = createSignal(false);
  const [findings, setFindings] = createSignal<SweepFinding[]>([]);
  const [note, setNote] = createSignal("AgentWatch opt-in off. No subprocess. No gating.");
  const [busy, setBusy] = createSignal(false);

  async function run(kind: "workspace" | "mailbox" | "snapshot" | "diff" | "loops" | "otel-start" | "otel-stop") {
    if (!enabled() && kind !== "otel-stop") { setNote("AgentWatch opt-in off. Enable to run a check."); return; }
    setBusy(true);
    try {
      const path = kind === "mailbox" ? "/api/agentwatch/mailbox"
        : kind === "snapshot" ? "/api/agentwatch/posture/snapshot"
        : kind === "diff" ? "/api/agentwatch/posture/diff"
        : kind === "loops" ? "/api/agentwatch/loops"
        : kind === "otel-start" ? "/api/agentwatch/otel/start"
        : kind === "otel-stop" ? "/api/agentwatch/otel/stop"
        : "/api/agentwatch/sweep";
      const res = await fetch(path, { method: kind === "loops" ? "GET" : "POST", headers: { "content-type": "application/json" }, body: kind === "loops" ? undefined : "{}" });
      const data = (await res.json()) as unknown;
      if (kind === "snapshot" || kind === "diff") {
        const d = data as { ok: boolean; baseline?: string; diff?: string[] };
        setNote(d.ok ? (d.diff?.length ? `${d.diff.length} diff(s): ${d.diff[0]}` : "Posture ok. Baseline saved.") : "Posture failed — blind spot stated.");
        setFindings([]);
      } else if (kind === "loops") {
        const d = data as { loops?: string[] };
        setNote(d.loops?.length ? `${d.loops.length} loop(s) suspected — human review` : "No stuck-agent loops detected.");
        setFindings([]);
      } else if (kind === "otel-start" || kind === "otel-stop") {
        setNote((data as { note?: string }).note ?? "otel toggled");
      } else {
        const d = data as { sweep?: { ok: boolean; findings?: SweepFinding[]; coverage?: string }; gate?: { allow: boolean; reason?: string } };
        const f = d.sweep?.findings ?? [];
        const g = d.gate?.reason ?? "";
        setFindings(f);
        setNote(d.sweep?.ok ? (f.length ? `${f.length} finding(s) — ${g}` : "Clean — no high/critical findings.") : `Sweep failed — blind spot stated. ${d.sweep?.coverage ?? ""}`);
      }
    } catch { setNote("Server not running."); }
    finally { setBusy(false); }
  }

  async function acknowledge(action: "approve" | "clean" | "detonate") {
    const entries = findings().map((f) => ({ rule: f.rule, file: f.file }));
    if (entries.length === 0) return;
    try {
      await fetch("/api/agentwatch/acknowledge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entries, action }) });
      setNote(action === "detonate" ? `Routed to Detonate lane (microVM, no net). ${entries.length} finding(s) logged as detonate.` : `${action === "approve" ? "Approved" : "Marked Clean"} by operator. ${entries.length} finding(s) acknowledged. Gate cleared for acknowledged items.`);
      setFindings([]);
    } catch { setNote("Server not running — acknowledgment not saved."); }
  }

  return (
    <div class="agentwatch-panel">
      <h3>AgentWatch — line-manager (opt-in)</h3>
      <label>
        <input type="checkbox" checked={enabled()} onChange={(e) => setEnabled(e.target.checked)} />
        Enable AgentWatch (local sweep)
      </label>
      <label>
        <input type="checkbox" checked={lineMgr()} onChange={(e) => setLineMgr(e.target.checked)} />
        Line-manager: block edit/bash until reviewed
      </label>
      <p>Default off so users who find checks stifling are not bothered. When on, it is a deterministic guide; operator review is paramount.</p>
      <div class="checks">
        <button disabled={busy()} onClick={() => run("workspace")}>Workspace</button>
        <button disabled={busy()} onClick={() => run("mailbox")}>Mailbox</button>
        <button disabled={busy()} onClick={() => run("snapshot")}>Posture snapshot</button>
        <button disabled={busy()} onClick={() => run("diff")}>Posture diff</button>
        <button disabled={busy()} onClick={() => run("loops")}>Loop check</button>
        <button disabled={busy()} onClick={() => run("otel-start")}>OTLP start</button>
        <button disabled={busy()} onClick={() => run("otel-stop")}>OTLP stop</button>
      </div>
      <p>{note()}</p>
      <ul>
        {findings().map((f) => (
          <li>{f.sev} {f.rule} — {f.file}</li>
        ))}
      </ul>
      {findings().length > 0 ? (
        <div class="review-actions">
          <button onClick={() => acknowledge("approve")}>Approve</button>
          <button onClick={() => acknowledge("clean")}>Clean</button>
          <button onClick={() => acknowledge("detonate")}>Detonate</button>
        </div>
      ) : null}
    </div>
  );
}
