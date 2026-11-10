// Event Horizon Code — Command palette (Ctrl+K). Fuzzy-ish filter, arrow keys, Enter runs.

import { createSignal, For, Show } from "solid-js";

export type Action = { label: string; hint?: string; run: () => void };

export default function CommandPalette(props: {
  open: () => boolean;
  close: () => void;
  actions: () => Action[];
}) {
  const [q, setQ] = createSignal("");
  const [sel, setSel] = createSignal(0);

  const filtered = () => {
    const needle = q().toLowerCase();
    return props.actions().filter((a) => a.label.toLowerCase().includes(needle));
  };

  const runAt = (i: number) => {
    const list = filtered();
    if (list[i]) { props.close(); setQ(""); setSel(0); list[i].run(); }
  };

  return (
    <Show when={props.open()}>
      <div class="palette-overlay" onClick={props.close}>
        <div class="palette" onClick={(e) => e.stopPropagation()}>
          <input
            autofocus
            placeholder="Type a command…"
            value={q()}
            onInput={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { props.close(); setQ(""); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered().length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter") { runAt(sel()); }
            }}
          />
          <div class="palette-list">
            <For each={filtered()}>
              {(a, i) => (
                <div class={i() === sel() ? "palette-item palette-sel" : "palette-item"} onMouseEnter={() => setSel(i())} onClick={() => runAt(i())}>
                  <span>{a.label}</span>
                  <Show when={a.hint}><span class="palette-hint">{a.hint}</span></Show>
                </div>
              )}
            </For>
            <Show when={filtered().length === 0}>
              <div class="palette-item palette-hint">no matching command</div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
