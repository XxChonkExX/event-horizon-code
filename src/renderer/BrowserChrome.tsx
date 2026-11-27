// Event Horizon Code — the browser window's chrome (S4). This page is OURS:
// address bar, back / forward / reload / stop, a lock, and the page state main
// pushes back. The web content itself is a WebContentsView owned by the main
// process in its own hardened session — it has no bridge to this page or the
// app. See docs/BROWSER.md and src/main/browser.ts.

import { createSignal, onCleanup, onMount, Show } from "solid-js";

export type BrowserState = { url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean; secure: boolean | null; blocked: string | null };

const BLANK = (u: string): boolean => u === "" || u === "about:blank";

export default function BrowserChrome() {
  const [state, setState] = createSignal<BrowserState>({ url: "", title: "", loading: false, canBack: false, canForward: false, secure: null, blocked: null });
  const [address, setAddress] = createSignal("");
  const [note, setNote] = createSignal("");
  let root: HTMLDivElement | undefined;

  const apply = (s: BrowserState): void => {
    setState(s);
    if (!document.activeElement || document.activeElement.className !== "bw-address") setAddress(BLANK(s.url) ? "" : s.url);
    setNote(s.blocked ?? "");
  };

  onMount(() => {
    const eh = window.eventhorizon;
    if (!eh?.browserCmd || !root) return;
    // Our own height decides where main places the view: the start page is
    // tall (the view is hidden behind nothing), the bar is short.
    const report = (): void => { eh.browserChrome!({ kind: "bounds", height: Math.ceil(root!.getBoundingClientRect().height) }); };
    const ro = new ResizeObserver(report);
    ro.observe(root);
    report();
    eh.onBrowserState!((s) => apply(s as BrowserState));
    void eh.browserCmd({ op: "state" }).then((r) => { if (r.state) apply(r.state as BrowserState); });
    onCleanup(() => ro.disconnect());
  });

  const cmd = async (op: "back" | "forward" | "reload" | "stop"): Promise<void> => {
    await window.eventhorizon?.browserCmd({ op });
  };
  const go = async (): Promise<void> => {
    const r = await window.eventhorizon?.browserCmd({ op: "navigate", url: address() });
    if (r && !r.ok) setNote(r.error ?? "could not navigate");
  };
  const started = (): boolean => !BLANK(state().url);

  return (
    <div class="bw-root" ref={root} classList={{ "bw-start": !started() }}>
      <div class="bw-bar">
        <button class="bw-btn" disabled={!state().canBack} title="Back" aria-label="Back" onClick={() => void cmd("back")}>‹</button>
        <button class="bw-btn" disabled={!state().canForward} title="Forward" aria-label="Forward" onClick={() => void cmd("forward")}>›</button>
        <button class="bw-btn" title={state().loading ? "Stop" : "Reload"} aria-label={state().loading ? "Stop" : "Reload"} onClick={() => void cmd(state().loading ? "stop" : "reload")}>{state().loading ? "×" : "↻"}</button>
        <span class="bw-lock" classList={{ "bw-lock-insecure": state().secure === false }} title={state().secure === true ? "Connected over HTTPS" : state().secure === false ? "Not secure - this page travels over plain HTTP" : ""}>
          {state().secure === true ? "🔒" : state().secure === false ? "⚠" : ""}
        </span>
        <input
          class="bw-address"
          type="text"
          value={address()}
          placeholder="Type a web address - https://example.com"
          spellcheck={false}
          autocomplete="off"
          aria-label="Address"
          onInput={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void go(); }}
        />
      </div>
      <Show when={note()}><div class="bw-note" role="status">{note()}</div></Show>
      <Show when={!started()}>
        <div class="bw-startpage">
          <div class="bw-start-title">A window on the web</div>
          <p>The page below runs in its own session: no shared cookies or storage with the workbench, no bridge to the app, every permission refused, and this machine and your LAN are unreachable from it. Nothing is kept when the window closes.</p>
          <p class="bw-start-dim">Only public <code>http</code>/<code>https</code> addresses load. Downloads are cancelled.</p>
        </div>
      </Show>
    </div>
  );
}
