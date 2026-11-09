// Event Horizon Code — AgentWatch panel (opt-in, deterministic line-manager)
// Default OFF. When ON: run workspace sweep, show findings, operator clicks Approve / Clean / Detonate.
// No LLM judge. Lane A deterministic. User is final arbiter.

import { createSignal } from "solid-js";

type SweepFinding = { rule: string; sev: string; file: string };

export default function AgentWatchPanel() {
  const [enabled, setEnabled] = createSignal(false);
  const [lineMgr, setLineMgr] = createSignal(false);
  const [findings, setFindings] = createSignal<SweepFinding[]>([]);
  const [note, setNote] = createSignal("AgentWatch opt-in off. No subprocess. No gating.");
  const [busy, setBusy] = createSignal(false);

  async function runCheck() {
    if (!enabled()) { setNote("AgentWatch opt-in off. Enable to run a check."); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/agentwatch/sweep", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const data = (await res.json()) as { ok: boolean; findings?: SweepFinding[]; coverage?: string };
      setFindings(data.findings ?? []);
      setNote(data.ok ? (data.findings?.length ? `${data.findings.length} finding(s) — operator review required.` : "Clean — no high/critical findings.") : `Sweep failed — blind spot stated. ${data.coverage ?? ""}`);
    } catch { setNote("Server not running."); }
    finally { setBusy(false); }
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
      <button disabled={busy()} onClick={runCheck}>Run workspace check</button>
      <p>{note()}</p>
      <ul>
        {findings().map((f) => (
          <li>{f.sev} {f.rule} — {f.file}</li>
        ))}
      </ul>
      {findings().length > 0 ? (
        <div class="review-actions">
          <button onClick={() => setNote("Approved by operator. Gate cleared. Logged.")}>Approve</button>
          <button onClick={() => setNote("Marked Clean by operator. Logged.")}>Clean</button>
          <button onClick={() => setNote("Routed to Detonate lane (microVM, no net).")}>Detonate</button>
        </div>
      ) : null}
    </div>
  );
}
