// Event Horizon Code - Terminal (real xterm over PTY SSE), with tabs.
//
// The parent opens each PTY and renders its tab; a body for that tab only wires
// xterm to the existing server id. Bodies stay mounted while hidden so
// scrollback and running commands survive switches. Closing a tab kills its PTY.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { apiFetch, eventStreamTicket, baseUrl } from "./api";

type Tab = { serverId: string; label: string };

export default function Terminal(props: { worktree: string }) {
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [active, setActive] = createSignal<string>("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const closeTab = (serverId: string) => {
    void apiFetch(`/api/terminal/${serverId}/kill`, { method: "POST", body: "{}" }).catch(() => {});
    setTabs((ts) => {
      const next = ts.filter((t) => t.serverId !== serverId);
      if (active() === serverId) setActive(next.length ? next[next.length - 1].serverId : "");
      return next;
    });
  };

  const newTab = () => {
    if (busy()) return;
    setBusy(true);
    void (async () => {
      try {
        const res = await apiFetch("/api/terminal/open", { method: "POST", body: JSON.stringify({ worktree: props.worktree }) });
        const opened = (await res.json()) as { ok: boolean; id?: string; error?: string };
        if (!opened.ok || !opened.id) { setError(opened.error ?? "the runtime refused to open a shell"); return; }
        setError("");
        const n = tabs().length + 1;
        const tab: Tab = { serverId: opened.id, label: `shell ${n}` };
        setTabs((ts) => [...ts, tab]);
        setActive(opened.id);
      } catch (e) {
        setError(`terminal unavailable: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      } finally {
        setBusy(false);
      }
    })();
  };

  onMount(() => { void newTab(); });
  onCleanup(() => {
    for (const t of tabs()) void apiFetch(`/api/terminal/${t.serverId}/kill`, { method: "POST", body: "{}" }).catch(() => {});
  });

  return (
    <div class="terminal-panel">
      <div class="term-tabs">
        <For each={tabs()}>
          {(t) => (
            <div class="term-tab" classList={{ "term-tab-on": active() === t.serverId }}>
              <span class="term-tab-label" onClick={() => setActive(t.serverId)}>{t.label}</span>
              <button class="term-tab-close" title="Close tab (kills the shell)" onClick={() => closeTab(t.serverId)}>x</button>
            </div>
          )}
        </For>
        <button class="term-tab-new" title="New shell tab" disabled={busy()} onClick={newTab}>+</button>
      </div>
      <div class="term-bodies">
        <For each={tabs()}>
          {(t) => <TermBody serverId={t.serverId} active={active} />}
        </For>
        <Show when={tabs().length === 0}>
          <div class="term-empty">
            <p>{error() || "no shell tab yet"}</p>
            <button onClick={newTab}>New shell</button>
          </div>
        </Show>
      </div>
    </div>
  );
}

function TermBody(props: { serverId: string; active: () => string }) {
  let ref: HTMLDivElement | undefined;

  onMount(() => {
    if (!ref) return;
    const term = new XTerm({ theme: { background: "#0c0c0c" }, fontSize: 12, cursorBlink: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref);
    try { fit.fit(); } catch { /* zero-size before layout */ }

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* zero-size mid-layout */ } });
    ro.observe(ref);
    onCleanup(() => ro.disconnect());

    // Terminal right-click (classic terminal UX): copy the selection, or paste
    // when nothing is selected. Paste flows through the PTY input path (the
    // same channel keystrokes use). Prevent default so neither Electron's
    // (absent) menu nor the in-page composer menu fires over the terminal.
    ref.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const sel = term.hasSelection() ? term.getSelection() : "";
      if (sel) { void navigator.clipboard.writeText(sel).catch(() => {}); return; }
      void navigator.clipboard.readText()
        .then((text) => { if (text) void apiFetch(`/api/terminal/${props.serverId}/input`, { method: "POST", body: JSON.stringify({ data: text }) }); })
        .catch(() => { /* clipboard unavailable - stated by the empty no-op */ });
    });

    void (async () => {
      try {
        const id = props.serverId;
        term.onData((data) => { void apiFetch(`/api/terminal/${id}/input`, { method: "POST", body: JSON.stringify({ data }) }); });
        term.onResize(({ cols, rows }) => { void apiFetch(`/api/terminal/${id}/resize`, { method: "POST", body: JSON.stringify({ cols, rows }) }); });
        // "Open in terminal" (file tree / editor tabs): only the ACTIVE tab's
        // PTY takes the cd. A request that arrived while the panel was closed
        // (no PTY existed) rides in __ehcPendingCd and is consumed once this
        // stream has attached.
        const w = window as unknown as { __ehcPendingCd?: string };
        const isMine = (): boolean => props.active() === id;
        const sendCd = (dir: string): void => {
          void apiFetch(`/api/terminal/${id}/input`, { method: "POST", body: JSON.stringify({ data: `cd "${dir.replace(/"/g, "")}"\r` }) });
        };
        const onCd = (ev: Event): void => {
          const d = (ev as CustomEvent<{ path?: string }>).detail;
          if (!d?.path || !isMine()) return;
          delete w.__ehcPendingCd;
          sendCd(d.path);
        };
        window.addEventListener("ehc:terminal-cd", onCd);
        onCleanup(() => window.removeEventListener("ehc:terminal-cd", onCd));
        const q = `ticket=${encodeURIComponent(await eventStreamTicket())}`;
        const es = new EventSource(`${baseUrl()}/api/terminal/${id}/stream?${q}`);
        es.onopen = () => {
          if (isMine() && w.__ehcPendingCd) {
            const pending = w.__ehcPendingCd;
            delete w.__ehcPendingCd;
            setTimeout(() => sendCd(pending), 400); // let the shell print its prompt first
          }
        };
        es.onmessage = (ev) => {
          try { term.write(JSON.parse(ev.data).d as string); } catch { /* skip malformed frame */ }
        };
        es.addEventListener("exit", () => { term.writeln("\r\n\x1b[90m[ehc] shell exited\x1b[0m"); es.close(); });
        term.writeln("\x1b[90m[ehc] terminal attached - per-worktree env\x1b[0m");
        onCleanup(() => es.close());
      } catch {
        term.writeln("\x1b[31m[ehc] server unreachable\x1b[0m");
      }
    })();

    onCleanup(() => { try { term.dispose(); } catch { /* ignore */ } });
  });

  return (
    <div
      class="terminal-body"
      ref={ref}
      style={{ display: props.active() === props.serverId ? "block" : "none" }}
    />
  );
}
