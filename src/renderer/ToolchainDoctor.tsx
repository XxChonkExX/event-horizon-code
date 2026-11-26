// Event Horizon Code - Toolchain Doctor panel
// Probes the languages/*/language.json toolchain.check commands server-side
// (GET /api/toolchain, ~4s, 70-90 spawns, concurrency-limited).
//
// NOTE: conditional rendering must go through <Show>. An early
// `if (signal()) return ...` inside a Solid component body is evaluated once at
// creation and never updates - which is exactly why this panel sat on
// "Checking toolchain..." forever.

import { createSignal, onMount, For, Show } from "solid-js";
import { apiJson, openExternal } from "./api";

type ToolCheck = {
  lang: string;
  displayName: string;
  cmd: string;
  ok: boolean;
  version: string;
  error?: string;
  /** Official install page, present only for a missing tool that has one. */
  install?: string;
  installNote?: string;
};

export default function ToolchainDoctor() {
  const [checks, setChecks] = createSignal<ToolCheck[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [err, setErr] = createSignal("");
  const [filter, setFilter] = createSignal<"all" | "missing">("all");

  const refresh = async () => {
    setLoading(true);
    setErr("");
    try {
      const data = await apiJson<ToolCheck[]>("/api/toolchain");
      setChecks(data);
      localStorage.setItem("ehc.toolchain", JSON.stringify(data));
    } catch {
      setErr("server unreachable - toolchain probe failed");
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    // Show the last known result immediately (the probe is ~80 spawns and can
    // idle under load); refresh in the background.
    try {
      const cached = localStorage.getItem("ehc.toolchain");
      if (cached) {
        const parsed = JSON.parse(cached) as ToolCheck[];
        if (Array.isArray(parsed) && parsed.length) setChecks(parsed);
      }
    } catch { /* corrupt cache - ignore */ }
    void refresh();
  });

  const missing = () => checks().filter((c) => !c.ok).length;
  const byLang = () => {
    const map = new Map<string, ToolCheck[]>();
    for (const c of checks()) {
      if (filter() === "missing" && c.ok) continue;
      if (!map.has(c.displayName)) map.set(c.displayName, []);
      map.get(c.displayName)!.push(c);
    }
    return Array.from(map.entries());
  };

  return (
    <div class="toolchain-doctor">
      <h3>Toolchain Doctor</h3>
      <div class="checks">
        <button disabled={loading()} onClick={() => void refresh()}>{loading() ? "checking..." : "Refresh"}</button>
        <button class="panel-toggle" classList={{ "panel-toggle-on": filter() === "missing" }} onClick={() => setFilter(filter() === "missing" ? "all" : "missing")}>
          missing only
        </button>
      </div>
      <Show when={checks().length > 0}>
        <div class="doctor-summary">
          <span class={missing() === 0 ? "doctor-ok" : "doctor-warn"}>
            {checks().length - missing()}/{checks().length} tools present
          </span>
          <Show when={missing() > 0}><span class="session-meta"> - {missing()} missing</span></Show>
        </div>
      </Show>
      <Show
        when={checks().length > 0}
        fallback={<p>{err() || (loading() ? "probing the toolchain (a few seconds)..." : "no language packs found in languages/")}</p>}
      >
        <div class="doctor-groups">
          <For each={byLang()}>
            {([name, items]) => {
              const allOk = items.every((i) => i.ok);
              return (
                <details open={!allOk}>
                  <summary class={allOk ? "doctor-ok" : "doctor-warn"}>
                    {allOk ? "OK" : "Missing"} - {name} ({items.filter((i) => i.ok).length}/{items.length})
                  </summary>
                  <ul>
                    <For each={items}>
                      {(i) => (
                        <li class={i.ok ? "doctor-ok" : "doctor-warn"}>
                          {i.ok ? "OK " : "MISS"} {i.cmd} - {i.version || i.error}
                          <Show when={!i.ok && i.install}>
                            <button
                              class="install-link"
                              title={`${i.installNote ? `${i.installNote} ` : ""}Opens the official install page in your browser. Nothing is installed by Event Horizon.`}
                              onClick={() => void openExternal(i.install!)}
                            >install</button>
                          </Show>
                          <Show when={!i.ok && i.installNote}>&nbsp;- <span class="session-meta">{i.installNote}</span></Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </details>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
