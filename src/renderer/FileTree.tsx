// Event Horizon Code - File tree
// Real workspace tree, lazily expanded one directory at a time (GET /api/files).
// Click a file to open it in the editor. Right-click a row for file operations:
// new file / new folder / rename / delete (fs:op in the main process, guarded),
// copy path (absolute or relative), reveal in the OS file manager, and open in
// the integrated terminal. Git status decorates names (modified / untracked /
// deleted) so the tree doubles as a lightweight change view.
// Skip-listed dirs (node_modules, .git, out, dist, build) never appear; the
// tree only ever shows what is on disk.

import { createSignal, createMemo, For, Show, onMount } from "solid-js";
import { apiJson, fsOp, revealInFolder, canReveal } from "./api";
import { openContextMenu } from "./ContextMenu";

type Entry = { name: string; type: "dir" | "file" };

export default function FileTree(props: { onSelect: (file: string) => void; root?: () => string }) {
  const [openDirs, setOpenDirs] = createSignal<Set<string>>(new Set());
  const [children, setChildren] = createSignal<Record<string, Entry[]>>({});
  const [loading, setLoading] = createSignal<Record<string, boolean>>({});
  const [err, setErr] = createSignal("");
  const [opErr, setOpErr] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [worktrees, setWorktrees] = createSignal<Array<{ id: string; path: string; branch: string }>>([]);
  // rel path -> git porcelain code ("M", "??", "D", ...). Empty outside a repo.
  const [gitStatus, setGitStatus] = createSignal<Record<string, string>>({});
  // Inline name entry for new/rename - never window.prompt (native modals are
  // banned in this app: they open off-screen and block the renderer).
  const [pendingNew, setPendingNew] = createSignal<{ dir: string; type: "file" | "dir"; name: string } | null>(null);
  const [pendingRename, setPendingRename] = createSignal<{ path: string; isDir: boolean; name: string } | null>(null);

  const toast = (text: string, kind: "ok" | "error" | "info" | "warn" = "info"): void => {
    window.dispatchEvent(new CustomEvent("ehc-toast", { detail: { text, kind } }));
  };

  // Paths the tree shows are workspace-relative; "Copy path" and "Reveal" want
  // the absolute native form (backslashes on Windows).
  const rootDir = (): string => (props.root?.() ?? "").replace(/[\\/]+$/, "");
  const absOf = (rel: string): string => {
    const base = rootDir();
    const joined = rel === "." || !rel ? base : `${base}/${rel}`;
    return base.includes("\\") ? joined.replace(/\//g, "\\") : joined;
  };

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

  // Git decoration is a read-only status call; a non-repo simply clears it.
  const refreshGit = async (): Promise<void> => {
    try {
      const g = await apiJson<{ ok?: boolean; status?: Record<string, string> }>("/api/files/gitstatus");
      setGitStatus(g?.status ?? {});
    } catch { setGitStatus({}); }
  };

  // Refresh every directory the user has open (keeps the expanded state).
  const refreshAll = async (): Promise<void> => {
    await Promise.all([...openDirs()].map((d) => listDir(d)));
    await refreshGit();
  };

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
    const r = await fsOp(op, props.root ? props.root() : undefined);
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
    void refreshGit();
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

  // ---- menu actions shared by rows, the root area, and editor tabs ----
  const copyAbs = (rel: string): void => { void navigator.clipboard.writeText(absOf(rel)).then(() => toast("absolute path copied", "ok")); };
  const copyRel = (rel: string): void => { void navigator.clipboard.writeText(rel).then(() => toast("relative path copied", "ok")); };
  const reveal = (rel: string): void => {
    void revealInFolder(rel, props.root?.()).then((r) => {
      if (!r.ok) toast(`could not reveal: ${r.error ?? "?"}`, "error");
    });
  };
  // cd the ACTIVE terminal into a directory. If the terminal is closed, the
  // request opens the panel first and the PTY consumes it on mount.
  const openInTerminal = (rel: string, isDir: boolean): void => {
    const target = isDir ? rel : parentOf(rel);
    (window as unknown as { __ehcPendingCd?: string }).__ehcPendingCd = absOf(target);
    window.dispatchEvent(new CustomEvent("ehc:want-terminal"));
    window.dispatchEvent(new CustomEvent("ehc:terminal-cd", { detail: { path: absOf(target) } }));
  };

  // Directories that contain a change get a subtle marker, like an editor's
  // SCM-decorated explorer - you can see where work is pending while collapsed.
  const dirtyDirs = createMemo(() => {
    const dirs = new Set<string>();
    for (const f of Object.keys(gitStatus())) {
      const parts = f.split("/");
      parts.pop();
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return dirs;
  });

  const gitClass = (full: string, isDir: boolean): Record<string, boolean> => {
    const code = gitStatus()[full];
    return {
      "ft-untracked": code === "??",
      "ft-deleted": Boolean(code && code.includes("D")),
      "ft-modified": Boolean(code && code !== "??" && !code.includes("D")),
      "ft-dir-dirty": isDir && dirtyDirs().has(full),
    };
  };

  function rowMenu(e: MouseEvent, full: string, isDir: boolean, name: string): void {
    openContextMenu(e, [
      ...(isDir ? [
        { label: "New file here", action: () => { setOpenDirs((s) => new Set(s).add(full)); setPendingNew({ dir: full, type: "file", name: "" }); } },
        { label: "New folder here", action: () => { setOpenDirs((s) => new Set(s).add(full)); setPendingNew({ dir: full, type: "dir", name: "" }); } },
      ] : []),
      { label: "Rename", action: () => setPendingRename({ path: full, isDir, name }) },
      { separator: true, label: "", action: () => {} },
      { label: "Copy path", action: () => copyAbs(full) },
      { label: "Copy relative path", action: () => copyRel(full) },
      { label: "Open in terminal", action: () => openInTerminal(full, isDir) },
      { label: "Reveal in file manager", disabled: !canReveal(), action: () => reveal(full) },
      { separator: true, label: "", action: () => {} },
      { label: isDir ? "Delete folder" : "Delete", danger: true, action: () => void runOp({ kind: "delete", path: full }) },
    ]);
  }

  // Right-click on the tree's empty area: workspace-level actions.
  function rootMenu(e: MouseEvent): void {
    openContextMenu(e, [
      { label: "New file", action: () => setPendingNew({ dir: ".", type: "file", name: "" }) },
      { label: "New folder", action: () => setPendingNew({ dir: ".", type: "dir", name: "" }) },
      { separator: true, label: "", action: () => {} },
      { label: "Refresh", action: () => void refreshAll() },
      { label: "Copy workspace path", action: () => copyAbs(".") },
      { label: "Open workspace in terminal", action: () => openInTerminal(".", true) },
      { label: "Reveal workspace in file manager", disabled: !canReveal(), action: () => reveal(".") },
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
                  <span class="ft-name" classList={{ "ft-dir-name": isDir, ...gitClass(full, isDir) }}>{e.name}</span>
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
    void refreshGit();
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
      <div class="ft-toolbar">
        <input
          class="ft-filter"
          placeholder="filter files..."
          value={filter()}
          onInput={(e) => setFilter(e.target.value)}
        />
        <button class="ft-tool" title="New file in the workspace root" onClick={() => setPendingNew({ dir: ".", type: "file", name: "" })}>+ file</button>
        <button class="ft-tool" title="New folder in the workspace root" onClick={() => setPendingNew({ dir: ".", type: "dir", name: "" })}>+ folder</button>
        <button class="ft-tool" title="Refresh the tree and git status" onClick={() => void refreshAll()}>↻</button>
      </div>
      <p class="ft-hint">Click a file to open it; right-click for new / rename / copy path / reveal / terminal.</p>
      {err() ? <p>{err()}</p> : null}
      {opErr() ? <p class="ft-hint">{opErr()}</p> : null}
      <ul class="ft-root" onContextMenu={rootMenu}>
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
