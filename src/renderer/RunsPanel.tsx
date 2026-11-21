// Event Horizon Code - Runs panel (Phase 3 of the Durable Agent Run)
// Execution timeline UI: lists durable runs (Session = conversation, Run =
// work), shows the selected run's timeline, and drives resume/cancel. Polls
// /api/runs lightly; timeline is fetched on demand.

import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { apiJson, apiFetch } from "./api";

type Run = {
  id: string;
  sessionId: string;
  objective: string;
  workdir: string;
  state: string;
  lane?: string | null;
  model?: string | null;
  started: string;
  updated: string;
  ended?: string | null;
  error?: string | null;
  result?: string | null;
};

type RunEvent = { runId: string; seq: number; ts: string; kind: string; detail: string };

const ACTIVE_STATES = new Set(["queued", "planning", "running", "awaiting_approval", "checkpointed"]);

function stateColor(state: string): string {
  if (state === "completed") return "#3fb950";
  if (state === "failed") return "#f85149";
  if (state === "interrupted") return "#d29922";
  if (ACTIVE_STATES.has(state)) return "#58a6ff";
  return "#8b949e"; // cancelled / other
}

export default function RunsPanel() {
  const [runs, setRuns] = createSignal<Run[]>([]);
  const [selected, setSelected] = createSignal<string | null>(null);
  const [events, setEvents] = createSignal<RunEvent[]>([]);
  const [busy, setBusy] = createSignal("");
  const [note, setNote] = createSignal("Runs are durable work records - they survive restarts. Interrupted runs can be resumed.");

  const refresh = async (): Promise<void> => {
    try {
      const list = await apiJson<Run[]>("/api/runs");
      setRuns(Array.isArray(list) ? list : []);
    } catch { /* server not running - keep the last list */ }
  };
  const openTimeline = async (id: string): Promise<void> => {
    setSelected(id);
    try {
      const t = await apiJson<{ run: Run; events: RunEvent[] }>(`/api/runs/${encodeURIComponent(id)}/timeline`);
      setEvents(t.events ?? []);
    } catch { setEvents([]); }
  };
  const act = async (id: string, action: "cancel" | "resume"): Promise<void> => {
    setBusy(`${action}:${id}`);
    setNote(action === "resume" ? "Resuming - the agent loop re-runs the objective with the timeline as context. This can take a while." : "Cancelling...");
    try {
      const res = await apiFetch(`/api/runs/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      setNote(body.ok ? `Run ${action} accepted.` : `Refused: ${body.error ?? "unknown error"}`);
    } catch (e) {
      setNote(`Refused: ${String(e).slice(0, 140)}`);
    }
    setBusy("");
    await refresh();
    if (selected() === id) await openTimeline(id);
  };

  onMount(() => {
    void refresh();
    const iv = setInterval(() => { void refresh(); }, 4000);
    onCleanup(() => clearInterval(iv));
  });

  const sel = (): Run | null => runs().find((r) => r.id === selected()) ?? null;

  return (
    <div class="runs-panel">
      <h3>Runs</h3>
      <div class="checks">
        <button onClick={() => { void refresh(); }}>Refresh</button>
        <span class="session-meta">polling every 4s</span>
      </div>
      <Show when={runs().length > 0} fallback={<p class="session-meta">No runs yet. Every chat prompt and SOP agent node creates one.</p>}>
        <ul class="runs-list" role="listbox">
          <For each={runs()}>{(r) => (
            <li
              class="session-meta"
              style={{ cursor: "pointer", background: selected() === r.id ? "rgba(88,166,255,0.12)" : "transparent" }}
              onClick={() => { void openTimeline(r.id); }}
            >
              <span style={{ color: stateColor(r.state), "font-weight": "600" }}>[{r.state}]</span>{" "}
              <span>{r.objective.slice(0, 90)}</span>
              <span class="session-meta" style={{ "margin-left": "8px" }}>
                {r.model ? `${r.model}` : "no model"}{r.lane ? ` / ${r.lane}` : ""}
              </span>
              <Show when={ACTIVE_STATES.has(r.state)}>
                <button disabled={busy() !== ""} onClick={(e) => { e.stopPropagation(); void act(r.id, "cancel"); }}>Cancel</button>
              </Show>
              <Show when={r.state === "interrupted"}>
                <button disabled={busy() !== ""} onClick={(e) => { e.stopPropagation(); void act(r.id, "resume"); }}>
                  {busy() === `resume:${r.id}` ? "resuming..." : "Resume"}
                </button>
              </Show>
            </li>
          )}</For>
        </ul>
      </Show>
      <Show when={sel()}>
        <details open>
          <summary>Timeline - {sel()!.id} ({sel()!.objective.slice(0, 60)})</summary>
          <Show when={sel()!.error} fallback={
            <Show when={sel()!.result}><p class="session-meta">result: {sel()!.result!.slice(0, 300)}</p></Show>
          }><p class="session-meta" style={{ color: "#f85149" }}>error: {sel()!.error}</p></Show>
          <ul class="sensory-list">
            <For each={events()}>{(e) => (
              <li class="session-meta">
                <span style={{ color: "#8b949e" }}>{e.ts.slice(11, 19)}</span>{" "}
                <span style={{ color: e.kind.startsWith("run.") ? "#d29922" : "#8b949e" }}>{e.kind}</span>{" "}
                {e.detail.slice(0, 220)}
              </li>
            )}</For>
          </ul>
        </details>
      </Show>
      <p class="session-meta">{note()}</p>
    </div>
  );
}
