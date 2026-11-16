// Event Horizon Code - Session Manager
// Full management view for every session in the store - the thing you need
// when a dozen (or a hundred) agent windows are in flight. Search, sort,
// hide from the tab strip, delete, or fork.

import { createSignal, For, Show, onMount } from "solid-js";
import { apiFetch, apiJson } from "./api";

type SessionRow = { id: string; title: string; messageCount: number; lastActivity?: string | null; created?: string };

type SortKey = "recent" | "size" | "title";

export default function SessionManager(props: {
  open: () => boolean;
  close: () => void;
  hidden: () => Set<string>;
  toggleHidden: (id: string) => void;
  fork: (id: string) => void;
}) {
  const [rows, setRows] = createSignal<SessionRow[]>([]);
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<SortKey>("recent");
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const load = async (): Promise<void> => {
    try {
      setRows(await apiJson<SessionRow[]>("/api/sessions"));
    } catch { setNote("could not load sessions"); }
  };
  onMount(() => void load());

  const filtered = (): SessionRow[] => {
    const q = query().trim().toLowerCase();
    const base = rows().filter((r) => !q || r.title.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
    const cmp: Record<SortKey, (a: SessionRow, b: SessionRow) => number> = {
      recent: (a, b) => (b.lastActivity ?? b.created ?? "").localeCompare(a.lastActivity ?? a.created ?? ""),
      size: (a, b) => b.messageCount - a.messageCount,
      title: (a, b) => (a.title || a.id).localeCompare(b.title || b.id),
    };
    return [...base].sort(cmp[sort()]);
  };

  const toggle = (id: string): void => {
    setSelected((s) => {
      const n = new Set<string>(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const toggleHiddenSel = (): void => {
    const ids = [...selected()];
    if (!ids.length) return;
    for (const id of ids) props.toggleHidden(id);
    setSelected(new Set<string>());
    setNote(`${ids.length} session(s) toggled`);
  };

  const delSel = async (): Promise<void> => {
    const ids = [...selected()];
    if (!ids.length) return;
    if (!window.confirm(`Delete ${ids.length} session(s) and their full history?`)) return;
    setBusy(true);
    try {
      for (const id of ids) await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      setSelected(new Set<string>());
      setNote(`${ids.length} session(s) deleted`);
      await load();
    } finally { setBusy(false); }
  };

  return (
    <Show when={props.open()}>
      <div class="session-manager-backdrop" onClick={props.close}>
        <div class="session-manager" role="dialog" aria-label="Session manager" onClick={(e) => e.stopPropagation()}>
          <div class="session-manager-head">
            <h3>Sessions <span class="session-manager-count">{rows().length}</span></h3>
            <div class="checks">
              <input class="ft-filter" placeholder="search title or id..." value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
              <select value={sort()} onChange={(e) => setSort(e.currentTarget.value as SortKey)} title="sort sessions">
                <option value="recent">recent</option>
                <option value="size">most messages</option>
                <option value="title">title</option>
              </select>
              <button onClick={props.close}>Close</button>
            </div>
          </div>

          <Show when={note()}><p class="session-meta">{note()}</p></Show>

          <div class="session-manager-bulk">
            <button onClick={() => setSelected(new Set(filtered().map((r) => r.id)))}>Select visible</button>
            <button onClick={() => setSelected(new Set())}>Clear</button>
            <span class="spacer" />
            <button onClick={toggleHiddenSel}>Toggle hidden</button>
            <button class="danger" disabled={busy()} onClick={() => void delSel()}>Delete selected ({selected().size})</button>
          </div>

          <div class="session-manager-list">
            <For each={filtered()}>
              {(r) => {
                const hidden = props.hidden().has(r.id);
                return (
                  <label class="session-manager-row" classList={{ "session-manager-hidden": hidden }}>
                    <input type="checkbox" checked={selected().has(r.id)} onChange={() => toggle(r.id)} />
                    <span class="session-manager-title" title={r.id}>{r.title || r.id}</span>
                    <span class="session-manager-meta">{r.messageCount} msg</span>
                    <span class="session-manager-meta">{(r.lastActivity ?? r.created ?? "").slice(0, 10)}</span>
                    <span class="session-manager-meta">{hidden ? "hidden" : ""}</span>
                    <button class="mini" onClick={(e) => { e.preventDefault(); props.fork(r.id); }}>fork</button>
                    <button class="mini" onClick={(e) => { e.preventDefault(); props.toggleHidden(r.id); }}>{hidden ? "show" : "hide"}</button>
                  </label>
                );
              }}
            </For>
            <Show when={filtered().length === 0}><p class="session-meta">no sessions match "{query()}"</p></Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
