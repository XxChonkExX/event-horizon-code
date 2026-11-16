// Event Horizon Code - Sessions panel
// Lists sessions with their checkpoints. This is where the multi-window
// workflow becomes visible: fork a session (full or from a checkpoint) and pop
// it into a second chat window; rename; delete. The current session is marked.

import { createSignal, onMount, Show } from "solid-js";
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
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  // Native confirm()/prompt() are banned in this app: a modal anchored to a
  // splayed window opens off-screen and blocks the renderer's JS thread, so
  // the delete would never even fire. Inline UI instead.
  // Delete is ONE click: the user checked the boxes / pressed the row button -
  // that is the intent, and every multi-step confirm variant (native dialog,
  // separate bar, in-place second press) failed to complete on this machine.
  // Feedback is immediate: rows vanish, the note line reports the count.
  const [renaming, setRenaming] = createSignal<{ id: string; value: string } | null>(null);

  const selectable = (): string[] => sessions().filter((s) => s.id !== currentSession).map((s) => s.id);
  const allSelected = (): boolean => selectable().length > 0 && selectable().every((id) => selected().has(id));
  const toggleAll = (): void => {
    setSelected(() => (allSelected() ? new Set<string>() : new Set(selectable())));
  };
  const toggleSel = (id: string): void => {
    setSelected((s) => {
      const n = new Set<string>(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const doDelete = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      for (const id of ids) {
        const r = await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!r.ok) throw new Error(`HTTP ${r.status} on session ${id.slice(0, 10)}`);
      }
      const gone = new Set(ids);
      setSelected((s) => new Set([...s].filter((id) => !gone.has(id))));
      if (gone.has(expanded())) setExpanded("");
      setNote(`${ids.length} session(s) deleted`);
      await refresh();
    } catch (e) {
      setNote(`delete failed: ${(e as Error).message ?? e}`);
    } finally { setBusy(false); }
  };

  const removeSelected = (): void => {
    const ids = [...selected()].filter((id) => id !== currentSession);
    if (ids.length === 0) return;
    void doDelete(ids);
  };

  const refresh = async (): Promise<void> => {
    try {
      const list = await apiJson<SessionMeta[]>("/api/sessions");
      setSessions(list);
      // Drop selections for sessions that no longer exist (bulk delete / panel delete).
      setSelected((s) => new Set([...s].filter((id) => list.some((x) => x.id === id))));
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

  const openWindow = (id: string, worktree?: string): void => { void popoutWindow("chat", id, worktree); };

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
        openWindow(d.sessionId, sessions().find((x) => x.id === id)?.worktree);
        await refresh();
      } else setNote(d.error ?? "fork failed");
    } finally { setBusy(false); }
  };

  const rename = (id: string, current: string): void => { setRenaming({ id, value: current }); };

  const commitRename = async (): Promise<void> => {
    const r = renaming();
    if (!r) return;
    const title = r.value.trim();
    if (!title) { setRenaming(null); return; }
    setBusy(true);
    try {
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(r.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
      if (!res.ok) { const d = (await res.json().catch(() => ({}))) as { error?: string }; setNote(`rename failed: ${d.error ?? `HTTP ${res.status}`}`); }
      setRenaming(null);
      await refresh();
    } finally { setBusy(false); }
  };

  const remove = (id: string): void => { void doDelete([id]); };

  return (
    <div class="sessions-panel">
      <h3>Session log</h3>
      {/* Feedback lives next to the controls - at the bottom of a scrolled list
          it was effectively invisible. */}
      <p class="session-note">{note()}</p>
      <div class="checks">
        <button disabled={busy()} onClick={() => void refresh()}>Refresh</button>
        <button disabled={busy()} onClick={() => { void fork(currentSession); }}>Fork current</button>
        <span class="session-check">
          <input type="checkbox" id="s-select-all" checked={allSelected()} onChange={toggleAll} title="Select every session except the current one" />
          <label for="s-select-all">Select all</label>
        </span>
        <button
          class="danger"
          disabled={busy() || selected().size === 0}
          title="Deletes every checked session immediately (the current one is never deleted)"
          onClick={removeSelected}
        >
          Delete selected ({selected().size})
        </button>
      </div>
      <ul class="session-list">
        {sessions().map((s) => (
          <li classList={{ current: s.id === currentSession }}>
            <div class="session-row">
              <input
                type="checkbox"
                checked={selected().has(s.id)}
                disabled={s.id === currentSession}
                title={s.id === currentSession ? "The current session cannot be deleted" : "Check to delete in bulk"}
                onChange={() => toggleSel(s.id)}
              />
              {renaming()?.id === s.id ? (
                <span class="session-rename">
                  <input
                    class="rename-input"
                    value={renaming()?.value ?? ""}
                    ref={(el) => queueMicrotask(() => el.focus())}
                    onInput={(e) => setRenaming((r) => (r ? { ...r, value: e.currentTarget.value } : r))}
                    onKeyDown={(e) => { if (e.key === "Enter") void commitRename(); else if (e.key === "Escape") setRenaming(null); }}
                  />
                  <button disabled={busy()} onClick={() => void commitRename()}>Save</button>
                  <button onClick={() => setRenaming(null)}>Cancel</button>
                </span>
              ) : (
                <span class="session-title" title={s.id}>{s.id === currentSession ? "* " : ""}{s.title}</span>
              )}
              <span class="session-meta">{s.messageCount} msg - {ago(s.lastActivity ?? s.created)}</span>
            </div>
            <div class="checks">
              <button disabled={busy()} onClick={() => openWindow(s.id, s.worktree)}>Open window</button>
              <button disabled={busy()} onClick={() => void fork(s.id)}>Fork</button>
              <button disabled={busy()} onClick={() => void openCheckpoints(s.id)}>{expanded() === s.id ? "Hide turns" : "Turns"}</button>
              <button disabled={busy()} onClick={() => rename(s.id, s.title)}>Rename</button>
              <button
                disabled={busy() || s.id === currentSession}
                title="Deletes this session and its history immediately. The current session cannot be deleted from its own window."
                onClick={() => remove(s.id)}
              >
                Delete
              </button>
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
    </div>
  );
}
