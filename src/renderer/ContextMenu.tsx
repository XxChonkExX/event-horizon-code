// Event Horizon Code - in-page right-click menu
// Deliberately NOT a native Menu.popup and NOT a fullscreen backdrop: both
// force the compositor re-presentations that splay this machine. A small
// positioned element stays in the page's own painting pipeline.

import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { editAction } from "./api";

export type CtxItem = { label: string; action: () => void; danger?: boolean; disabled?: boolean };

const [items, setItems] = createSignal<CtxItem[]>([]);
const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);

export function openContextMenu(e: MouseEvent, menu: CtxItem[]): void {
  const live = menu.filter((m) => !m.disabled);
  if (live.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  setItems(live);
  setPos({
    x: Math.max(4, Math.min(e.clientX, window.innerWidth - 230)),
    y: Math.max(4, Math.min(e.clientY, window.innerHeight - 36 - live.length * 30)),
  });
}

export default function ContextMenu() {
  const close = (): void => { setPos(null); };

  // Default text menu: copy/cut/paste/select all for inputs and selections.
  // Monaco ships its own context menu - right-clicks there are left alone.
  onMount(() => {
    const onCtx = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".monaco-editor")) return;
      const editable = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable;
      const selection = String(window.getSelection?.() ?? "").trim().length > 0;
      if (!editable && !selection) return;
      const menu: CtxItem[] = [];
      if (selection) menu.push({ label: "Copy", action: () => void editAction("copy") });
      if (editable && selection) menu.push({ label: "Cut", action: () => void editAction("cut") });
      if (editable) menu.push({ label: "Paste", action: () => void editAction("paste") });
      if (editable) menu.push({ label: "Select all", action: () => void editAction("selectAll") });
      openContextMenu(e, menu);
    };
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null;
      if (pos() && !t?.closest(".ctx-menu")) close();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
    window.addEventListener("contextmenu", onCtx);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    });
  });

  return (
    <Show when={pos()}>
      <div class="ctx-menu" style={{ left: `${pos()!.x}px`, top: `${pos()!.y}px` }} role="menu">
        <For each={items()}>
          {(it) => (
            <button
              class="ctx-item"
              classList={{ danger: it.danger }}
              role="menuitem"
              onClick={() => { close(); it.action(); }}
            >
              {it.label}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
