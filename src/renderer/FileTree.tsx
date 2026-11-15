// Event Horizon Code - File tree
// Real workspace tree, lazily expanded one directory at a time (GET /api/files).
// Click a file to open it in the editor. Skip-listed dirs (node_modules, .git,
// out, dist, build) never appear; the tree only ever shows what is on disk.

import { createSignal, For, Show, onMount } from "solid-js";
import { apiJson } from "./api";

type Entry = { name: string; type: "dir" | "file" };

export default function FileTree(props: { onSelect: (file: string) => void }) {
  const [openDirs, setOpenDirs] = createSignal<Set<string>>(new Set());
  const [children, setChildren] = createSignal<Record<string, Entry[]>>({});
  const [loading, setLoading] = createSignal<Record<string, boolean>>({});
  const [err, setErr] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [worktrees, setWorktrees] = createSignal<Array<{ id: string; path: string; branch: string }>>([]);

  async function listDir(dir: string): Promise<void> {
    setLoading((l) => ({ ...l, [dir]: true }));
    try {
      const d = await apiJson<{ entries: Entry[] }>(`/api/files?path=${encodeURIComponent(dir)}`);
      setChildren((c) => ({ ...c, [dir]: d.entries ?? [] }));
      setErr("");
    } catch {
      setErr("File listing unavailable - is the server running?");
    } finally {
      setLoading((l) => ({ ...l, [dir]: false }));
    }
  }

  const toggle = (dir: string): void => {
    const open = openDirs().has(dir);
    setOpenDirs((s) => {
      const next = new Set(s);
      if (open) next.delete(dir); else next.add(dir);
      return next;
    });
    if (!open && !children()[dir]) void listDir(dir);
  };

  const matches = (name: string): boolean => !filter() || name.toLowerCase().includes(filter().toLowerCase());

  const Rows = (p: { dir: string; depth: number }) => (
    <Show when={p.depth === 0 || openDirs().has(p.dir)}>
      <For each={(children()[p.dir] ?? []).filter((e) => matches(e.name))}>
        {(e) => {
          const full = p.dir === "." ? e.name : `${p.dir}/${e.name}`;
          const isDir = e.type === "dir";
          return (
            <li>
              <button
                class="ft-row"
                style={{ "padding-left": `${8 + p.depth * 14}px` }}
                onClick={() => (isDir ? toggle(full) : props.onSelect(full))}
              >
                <span class="ft-icon">{isDir ? (openDirs().has(full) ? "-" : "+") : "*"}</span>
                <span class="ft-name" classList={{ "ft-dir-name": isDir }}>{e.name}</span>
              </button>
              <Show when={isDir}>
                <Show when={loading()[full]}><span class="ft-loading">loading...</span></Show>
                <Rows dir={full} depth={p.depth + 1} />
              </Show>
            </li>
          );
        }}
      </For>
    </Show>
  );

  onMount(() => {
    setOpenDirs((s) => new Set(s).add("."));
    void listDir(".");
    void (async () => {
      try { setWorktrees(await apiJson("/api/worktrees")); } catch { /* optional */ }
    })();
  });

  return (
    <div class="file-tree">
      <Show when={worktrees().length > 1} fallback={<h3>Workspace</h3>}>
        <h3>Worktrees</h3>
        <div class="checks">
          {worktrees().map((w) => <span class="status-badge" title={w.path}>{w.branch || w.id}</span>)}
        </div>
        <h3>Workspace</h3>
      </Show>
      <input
        class="ft-filter"
        placeholder="filter files..."
        value={filter()}
        onInput={(e) => setFilter(e.target.value)}
      />
      {err() ? <p>{err()}</p> : null}
      <ul class="ft-root">
        <Rows dir="." depth={0} />
      </ul>
    </div>
  );
}
