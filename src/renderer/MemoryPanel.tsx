// Event Horizon Code - Memory panel
// Shows the project memory that replays into every session's system prompt
// (.harness/memory.md), and drives the auto-memory loop: extract proposals
// from this session's transcript, review them, apply only the approved ones.
// Nothing is written without an explicit operator click.

import { createSignal, onMount } from "solid-js";
import { apiFetch, apiJson } from "./api";

const currentSession = new URLSearchParams(location.search).get("session") ?? "default";

export default function MemoryPanel() {
  const [lines, setLines] = createSignal<string[]>([]);
  const [proposals, setProposals] = createSignal<string[]>([]);
  const [picked, setPicked] = createSignal<Set<string>>(new Set());
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal("Memory replays into every future session. Proposals are extracted from this session - nothing is applied without your approval.");

  const refresh = async (): Promise<void> => {
    try {
      const d = await apiJson<{ lines: string[] }>("/api/memory");
      setLines(d.lines);
    } catch { setNote("Server not running."); }
  };
  onMount(() => void refresh());

  const extract = async (): Promise<void> => {
    setBusy(true);
    setProposals([]);
    try {
      const r = await apiFetch("/api/memory/extract", { method: "POST", body: JSON.stringify({ sessionId: currentSession }) });
      const d = (await r.json()) as { ok?: boolean; proposals?: string[]; error?: string };
      if (d.ok && d.proposals?.length) {
        setProposals(d.proposals);
        setPicked(new Set(d.proposals));
        setNote(`${d.proposals.length} proposal(s) - uncheck anything you do not want, then Apply.`);
      } else if (d.ok) {
        setNote("Nothing worth remembering was proposed.");
      } else setNote(d.error ?? "extraction failed");
    } finally { setBusy(false); }
  };

  const apply = async (): Promise<void> => {
    const texts = Array.from(picked());
    if (!texts.length) { setNote("Nothing selected."); return; }
    setBusy(true);
    try {
      const r = await apiFetch("/api/memory/apply", { method: "POST", body: JSON.stringify({ texts }) });
      const d = (await r.json()) as { added?: number; error?: string };
      setNote(d.added !== undefined ? `${d.added} line(s) added to project memory.` : d.error ?? "apply failed");
      setProposals([]);
      setPicked(new Set<string>());
      await refresh();
    } finally { setBusy(false); }
  };

  const toggle = (t: string): void => {
    setPicked((p) => {
      const next = new Set<string>(p);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  return (
    <div class="memory-panel">
      <h3>Memory</h3>
      {lines().length === 0
        ? <p class="session-meta">No project memory yet.</p>
        : <ul class="memory-lines">{lines().map((l) => <li>{l}</li>)}</ul>}
      <div class="checks">
        <button disabled={busy()} onClick={() => void extract()} title="Propose durable memories from this session's transcript">Propose from session</button>
        <button disabled={busy()} onClick={() => void refresh()}>Refresh</button>
      </div>
      {proposals().length > 0 && (
        <div class="proposal-list">
          {proposals().map((p) => (
            <label>
              <input type="checkbox" checked={picked().has(p)} onChange={() => toggle(p)} />
              <span>{p}</span>
            </label>
          ))}
          <div class="checks">
            <button disabled={busy() || picked().size === 0} onClick={() => void apply()}>Apply selected ({picked().size})</button>
          </div>
        </div>
      )}
      <p>{note()}</p>
    </div>
  );
}
