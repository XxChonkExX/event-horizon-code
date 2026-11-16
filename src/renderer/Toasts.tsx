// Event Horizon Code - Toast notifications
// Bottom-right, auto-dismissing, non-blocking. Used for status the user does
// not need in the conversation (worktree, fork, checkpoint, save results).

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";

export type Toast = { id: number; text: string; kind: "info" | "ok" | "warn" | "error" };

const ICONS: Record<Toast["kind"], string> = { info: "i", ok: "+", warn: "!", error: "x" };

export default function Toasts(props: { toasts: Accessor<Toast[]>; dismiss: (id: number) => void }) {
  return (
    <div class="toast-stack">
      <For each={props.toasts()}>
        {(t) => (
          <Show when={true}>
            <div class={`toast toast-${t.kind}`} onClick={() => props.dismiss(t.id)} title="click to dismiss">
              <span class="toast-icon">{ICONS[t.kind]}</span>
              <span class="toast-text">{t.text}</span>
            </div>
          </Show>
        )}
      </For>
    </div>
  );
}
