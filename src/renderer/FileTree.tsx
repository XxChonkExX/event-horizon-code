// Event Horizon Code - File tree
// Real workspace tree, lazily expanded one directory at a time (GET /api/files).
// Click a file to open it in the editor. Right-click a row for file operations:
// new file / new folder / rename / delete (fs:op in the main process, guarded).
// Skip-listed dirs (node_modules, .git, out, dist, build) never appear; the
// tree only ever shows what is on disk.

import { createSignal, For, Show, onMount } from "solid-js";
import { apiJson, fsOp } from "./api";
import { openContextMenu } from "./ContextMenu";

type Entry = { name: string; type: "dir" | "file" };

export default function FileTree(props: { onSelect: (file: string) => void }) {
  const [openDirs, setOpenDirs] = createSignal<Set<string>>(new Set());
  const [children, setChildren] = createSignal<Record<string, Entry[]>>({});
  const [loading, setLoading] = createSignal<Record<string, boolean>>({});
  const [err, setErr] = createSignal("");
  const [opErr, setOpErr] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [worktrees, setWorktrees] = createSignal<Array<{ id: string; path: string; branch: string }>>([]);
  // Inline name entry for new/rename - never window.prompt (native modals are
  // banned in this app: they open off-screen and block the renderer).
  const [pendingNew, setPendingNew] = createSignal<{ dir: string; type: "file" | "dir"; name: string } | null>(null);
  const [pendingRename, setPendingRename] = createSignal<{ path: string; isDir: boolean; name: string } | null>(null);

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

  const parentOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

  async function runOp(op: { kind: string; path: string; to?: string; type?: string }): Promise<void> {
    const r = await fsOp(op);
    if (!r.ok) { setOpErr(r.error ?? "operation failed"); return; }
    setOpErr("");
    setPendingNew(null);
    setPendingRename(null);
    const parent = parentOf(op.kind === "rename" && op.to ? op.to : op.path);
    await listDir(parent);
    if (parent !== ".") await listDir(".");
    if (op.kind === "delete" && openDirs().has(op.path)) {
      setOpenDirs((s) => { const n = new Set(s); n.delete(op.path); return n; });
    }
  }

  const commitNew = async (): Promise<void> => {
    const p = pendingNew();
    if (!p || !p.name.trim()) { setPendingNew(null); return; }
    const full = p.dir === "." ? p.name.trim() : `${p.dir}/${p.name.trim()}`;
    await runOp({ kind: p.type === "file" ? "newFile" : "newDir", path: full, type: p.type });
  };

  const commitRename = async (): Promise<void> => {
    const r = pendingRename();
    if (!r || !r.name.trim()) { setPendingRename(null); return; }
    const parent = parentOf(r.path);
    const to = parent === "." ? r.name.trim() : `${parent}/${r.name.trim()}`;
    await runOp({ kind: "rename", path: r.path, to });
  };

  function rowMenu(e: MouseEvent, full: string, isDir: boolean, name: string): void {
    openContextMenu(e, [
      ...(isDir ? [
        { label: "New file here", action: () => { setOpenDirs((s) => new Set(s).add(full)); setPendingNew({ dir: full, type: "file", name: "" }); } },
        { label: "New folder here", action: () => { setOpenDirs((s) => new Set(s).add(full)); setPendingNew({ dir: full, type: "dir", name: "" }); } },
      ] : []),
      { label: "Rename", action: () => setPendingRename({ path: full, isDir, name }) },
      { label: "Delete", danger: true, action: () => void runOp({ kind: "delete", path: full }) },
    ]);
  }

  const Rows = (p: { dir: string; depth: number }) => (
    <Show when={p.depth === 0 || openDirs().has(p.dir)}>
      <For each={(children()[p.dir] ?? []).filter((e) => matches(e.name))}>
        {(e) => {
          const full = p.dir === "." ? e.name : `${p.dir}/${e.name}`;
          const isDir = e.type === "dir";
          const renaming = pendingRename()?.path === full;
          return (
            <li>
              <button
                class="ft-row"
                style={{ "padding-left": `${8 + p.depth * 14}px` }}
                onClick={() => (isDir ? toggle(full) : props.onSelect(full))}
                onContextMenu={(ev) => rowMenu(ev, full, isDir, e.name)}
                title="Click to open / expand - right-click for file options"
              >
                <span class="ft-icon">{isDir ? (openDirs().has(full) ? "-" : "+") : "*"}</span>
                {renaming ? (
                  <input
                    class="rename-input"
                    value={pendingRename()?.name ?? ""}
                    ref={(el) => queueMicrotask(() => el.focus())}
                    onClick={(ev) => ev.stopPropagation()}
                    onInput={(ev) => setPendingRename((r) => (r ? { ...r, name: ev.currentTarget.value } : r))}
                    onKeyDown={(ev) => { if (ev.key === "Enter") void commitRename(); else if (ev.key === "Escape") setPendingRename(null); }}
                  />
                ) : (
                  <span class="ft-name" classList={{ "ft-dir-name": isDir }}>{e.name}</span>
                )}
              </button>
              {renaming ? (
                <span class="ft-op-row" style={{ "padding-left": `${24 + p.depth * 14}px` }}>
                  <button onClick={() => void commitRename()}>Save</button>
                  <button onClick={() => setPendingRename(null)}>Cancel</button>
                </span>
              ) : null}
              <Show when={isDir}>
                <Show when={pendingNew()?.dir === full}>
                  <span class="ft-op-row" style={{ "padding-left": `${24 + p.depth * 14}px` }}>
                    <input
                      class="rename-input"
                      placeholder={pendingNew()?.type === "file" ? "new-file.py" : "new-folder"}
                      value={pendingNew()?.name ?? ""}
                      ref={(el) => queueMicrotask(() => el.focus())}
                      onInput={(ev) => setPendingNew((n) => (n ? { ...n, name: ev.currentTarget.value } : n))}
                      onKeyDown={(ev) => { if (ev.key === "Enter") void commitNew(); else if (ev.key === "Escape") setPendingNew(null); }}
                    />
                    <button onClick={() => void commitNew()}>Create</button>
                    <button onClick={() => setPendingNew(null)}>Cancel</button>
                  </span>
                </Show>
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
      <p class="ft-hint">Click a file to open it; right-click for new / rename / delete.</p>
      {err() ? <p>{err()}</p> : null}
      {opErr() ? <p class="ft-hint">{opErr()}</p> : null}
      <ul class="ft-root">
        <Show when={pendingNew()?.dir === "."}>
          <span class="ft-op-row">
            <input
              class="rename-input"
              placeholder={pendingNew()?.type === "file" ? "new-file.py" : "new-folder"}
              value={pendingNew()?.name ?? ""}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(ev) => setPendingNew((n) => (n ? { ...n, name: ev.currentTarget.value } : n))}
              onKeyDown={(ev) => { if (ev.key === "Enter") void commitNew(); else if (ev.key === "Escape") setPendingNew(null); }}
            />
            <button onClick={() => void commitNew()}>Create</button>
            <button onClick={() => setPendingNew(null)}>Cancel</button>
          </span>
        </Show>
        <Rows dir="." depth={0} />
      </ul>
    </div>
  );
}
