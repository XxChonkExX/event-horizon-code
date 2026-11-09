// Event Horizon Code — File tree (SolidJS)
// Fetches worktrees from local server. No filesystem via IPC.

import { createSignal } from "solid-js";

type WT = { id: string; path: string; branch: string };

export default function FileTree({ onSelect }: { onSelect: (file: string) => void }) {
  const [items, setItems] = createSignal<WT[]>([]);
  const [err, setErr] = createSignal("");

  async function load() {
    try {
      const res = await fetch("/api/worktrees");
      const data = (await res.json()) as WT[];
      setItems(Array.isArray(data) ? data : []);
    } catch { setErr("Worktrees unavailable (server not running)."); }
  }

  return (
    <div class="file-tree">
      <h3>Worktrees</h3>
      <button onClick={load}>Refresh</button>
      {err() ? <p>{err()}</p> : null}
      <ul>
        {items().map((w) => (
          <li>
            <button onClick={() => onSelect(w.path)}>{w.id || w.path} — {w.branch}</button>
          </li>
        ))}
      </ul>
      <p>Full file listing via LSP/ctags in next pass.</p>
    </div>
  );
}
