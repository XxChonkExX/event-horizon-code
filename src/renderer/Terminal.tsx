// Event Horizon Code — Terminal (real xterm over PTY SSE)
// One terminal per window, bound to the session worktree.
// Stream = EventSource with ?auth= (EventSource cannot send headers).

import { onMount, onCleanup } from "solid-js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { apiFetch, authQuery, baseUrl } from "./api";

export default function Terminal(props: { worktree: string }) {
  let ref: HTMLDivElement | undefined;

  onMount(async () => {
    if (!ref) return;
    const term = new XTerm({ theme: { background: "#0c0c0c" }, fontSize: 12, cursorBlink: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref);
    try { fit.fit(); } catch { /* zero-size before layout */ }

    try {
      const openRes = await apiFetch("/api/terminal/open", {
        method: "POST",
        body: JSON.stringify({ worktree: props.worktree }),
      });
      const opened = (await openRes.json()) as { ok: boolean; id?: string; error?: string; cwdNote?: string };
      if (!opened.ok || !opened.id) {
        term.writeln(`\x1b[33m[ehc] terminal unavailable: ${opened.error ?? "unknown"}\x1b[0m`);
        return;
      }
      const id = opened.id;
      if (opened.cwdNote) term.writeln(`\x1b[33m[ehc] ${opened.cwdNote}\x1b[0m`);
      term.onData((data) => { void apiFetch(`/api/terminal/${id}/input`, { method: "POST", body: JSON.stringify({ data }) }); });
      term.onResize(({ cols, rows }) => { void apiFetch(`/api/terminal/${id}/resize`, { method: "POST", body: JSON.stringify({ cols, rows }) }); });

      const q = await authQuery();
      const es = new EventSource(`${baseUrl()}/api/terminal/${id}/stream?${q}`);
      es.onmessage = (ev) => {
        // Server frames chunks as JSON ({d: chunk}) — escape bytes (ANSI colors)
        // survive transport; manual string replaces garbled them (the "o001b[" bug).
        try { term.write(JSON.parse(ev.data).d as string); } catch { /* skip malformed frame */ }
      };
      es.addEventListener("exit", () => { term.writeln("\r\n\x1b[90m[ehc] shell exited\x1b[0m"); es.close(); });
      term.writeln("\x1b[90m[ehc] terminal attached — per-worktree env\x1b[0m");

      onCleanup(() => {
        es.close();
        void apiFetch(`/api/terminal/${id}/kill`, { method: "POST", body: "{}" });
        term.dispose();
      });
    } catch {
      term.writeln("\x1b[31m[ehc] server unreachable\x1b[0m");
    }
  });

  return <div class="terminal-body" ref={ref} />;
}
