// Event Horizon Code - Editor tabs (VS Code structure)
// Classes ehc-prefixed: generic names collided with the editor's internal styles.
// Right-click a tab: close / close others / close all, copy path, open in the
// terminal, reveal in the OS file manager (the same actions the file tree has).

import { For } from "solid-js";
import { openContextMenu } from "./ContextMenu";
import { revealInFolder, canReveal } from "./api";

export default function Tabs(props: {
  files: () => string[];
  active: () => string;
  onSelect: (f: string) => void;
  onClose: (f: string) => void;
  onCloseOthers?: (keep: string) => void;
  onCloseAll?: () => void;
  root?: () => string;
}) {
  const rootDir = (): string => (props.root?.() ?? "").replace(/[\\/]+$/, "");
  const absOf = (rel: string): string => {
    const base = rootDir();
    const joined = `${base}/${rel}`;
    return base.includes("\\") ? joined.replace(/\//g, "\\") : joined;
  };
  const toast = (text: string, kind: "ok" | "error" = "ok"): void => {
    window.dispatchEvent(new CustomEvent("ehc-toast", { detail: { text, kind } }));
  };
  const parentOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

  function tabMenu(e: MouseEvent, f: string): void {
    openContextMenu(e, [
      { label: "Close", action: () => props.onClose(f) },
      { label: "Close others", action: () => (props.onCloseOthers ? props.onCloseOthers(f) : undefined) },
      { label: "Close all", action: () => (props.onCloseAll ? props.onCloseAll() : undefined) },
      { separator: true, label: "", action: () => {} },
      { label: "Copy path", action: () => void navigator.clipboard.writeText(absOf(f)).then(() => toast("absolute path copied")) },
      { label: "Copy relative path", action: () => void navigator.clipboard.writeText(f).then(() => toast("relative path copied")) },
      {
        label: "Open folder in terminal",
        action: () => {
          const target = absOf(parentOf(f));
          (window as unknown as { __ehcPendingCd?: string }).__ehcPendingCd = target;
          window.dispatchEvent(new CustomEvent("ehc:want-terminal"));
          window.dispatchEvent(new CustomEvent("ehc:terminal-cd", { detail: { path: target } }));
        },
      },
      {
        label: "Reveal in file manager",
        disabled: !canReveal(),
        action: () => void revealInFolder(f, props.root?.()).then((r) => { if (!r.ok) toast(`could not reveal: ${r.error ?? "?"}`, "error"); }),
      },
    ]);
  }

  return (
    <div class="ehc-tabs">
      {props.files().map((f) => (
        <div class={f === props.active() ? "ehc-tab ehc-tab-on" : "ehc-tab"} onClick={() => props.onSelect(f)} onContextMenu={(e) => tabMenu(e, f)}>
          <span class="ehc-tab-name">{f.split(/[\\/]/).pop()}</span>
          <span class="ehc-tab-close" title="Close" onClick={(e) => { e.stopPropagation(); props.onClose(f); }}>x</span>
        </div>
      ))}
    </div>
  );
}
