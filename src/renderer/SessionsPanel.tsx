// Event Horizon Code - Sessions panel
// Lists sessions with their checkpoints. This is where the multi-window
// workflow becomes visible: fork a session (full or from a checkpoint) and pop
// it into a second chat window; rename; delete. The current session is marked.

import { createSignal, onMount } from "solid-js";
import { apiFetch, apiJson, popoutWindow } from "./api";

type SessionMeta = { id: string; title: string; worktree: string; created: string; lastActivity?: string | null; messageCount: number };
type Checkpoint = { sessionId: string; seq: number; label: string; ts: string };

const currentSession = new URLSearchParams(location.search).get("session") ?? "default";

function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function SessionsPanel() {
  const [sessions, setSessions] = createSignal<SessionMeta[]>([]);
  const [expanded, setExpanded] = createSignal<string>("");
  const [checkpoints, setCheckpoints] = createSignal<Checkpoint[]>([]);
  const [note, setNote] = createSignal("Fork to try a second approach in a parallel window; the original is untouched.");
  const [busy, setBusy] = createSignal(false);

  const refresh = async (): Promise<void> => {
    try {
      const list = await apiJson<SessionMeta[]>("/api/sessions");
      setSessions(list);
    } catch { setNote("Server not running."); }
  };
  onMount(() => void refresh());

  const openCheckpoints = async (id: string): Promise<void> => {
    if (expanded() === id) { setExpanded(""); return; }
    setExpanded(id);
    try {
      setCheckpoints(await apiJson<Checkpoint[]>(`/api/sessions/${encodeURIComponent(id)}/checkpoints`));
    } catch { setCheckpoints([]); }
  };

  const openWindow = (id: string): void => { void popoutWindow("chat", id); };

  const fork = async (id: string, atSeq?: number, label?: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/sessions/${encodeURIComponent(id)}/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(atSeq !== undefined ? { atSeq } : {}), title: label ? `${label} (fork)` : undefined }),
      });
      const d = (await r.json()) as { sessionId?: string; error?: string };
      if (d.sessionId) {
        setNote(`Forked -> ${d.sessionId}`);
        openWindow(d.sessionId);
        await refresh();
      } else setNote(d.error ?? "fork failed");
    } finally { setBusy(false); }
  };

  const rename = async (id: string, current: string): Promise<void> => {
    const title = window.prompt("Rename session", current);
    if (title === null || !title.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) });
      await refresh();
    } finally { setBusy(false); }
  };

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm(`Delete session "${id}" and its messages, instructions and checkpoints?`)) return;
    setBusy(true);
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (expanded() === id) setExpanded("");
      await refresh();
    } finally { setBusy(false); }
  };

  return (
    <div class="sessions-panel">
      <h3>Sessions</h3>
      <div class="checks">
        <button disabled={busy()} onClick={() => void refresh()}>Refresh</button>
        <button disabled={busy()} onClick={() => { void fork(currentSession); }}>Fork current</button>
      </div>
      <ul class="session-list">
        {sessions().map((s) => (
          <li classList={{ current: s.id === currentSession }}>
            <div class="session-row">
              <span class="session-title" title={s.id}>{s.id === currentSession ? "* " : ""}{s.title}</span>
              <span class="session-meta">{s.messageCount} msg - {ago(s.lastActivity ?? s.created)}</span>
            </div>
            <div class="checks">
              <button disabled={busy()} onClick={() => openWindow(s.id)}>Open window</button>
              <button disabled={busy()} onClick={() => void fork(s.id)}>Fork</button>
              <button disabled={busy()} onClick={() => void openCheckpoints(s.id)}>{expanded() === s.id ? "Hide turns" : "Turns"}</button>
              <button disabled={busy()} onClick={() => void rename(s.id, s.title)}>Rename</button>
              <button disabled={busy() || s.id === currentSession} title="The current session cannot be deleted from its own window" onClick={() => void remove(s.id)}>Delete</button>
            </div>
            {expanded() === s.id && (
              <div class="checkpoint-list">
                {checkpoints().length === 0 ? <span class="session-meta">no checkpoints yet - every prompt records one</span> : checkpoints().slice().reverse().map((c) => (
                  <div class="checkpoint-row">
                    <span class="session-meta" title={c.ts}>@{c.seq} - {c.label}</span>
                    <button disabled={busy()} onClick={() => void fork(s.id, c.seq, c.label)}>Fork from here</button>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p>{note()}</p>
    </div>
  );
}
