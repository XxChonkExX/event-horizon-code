// Event Horizon Code — Sensors panel: the sensor bus's face.
//
// Everything here is the USER acting. Sources are off until started here (or
// in their own window); a watch is a standing question the user defines; the
// bridge is opened by the user and its token never crosses the API. The one
// switch sits at the top: one activation, no confirmation dialog (off is the
// safe state, and a dialog is a barrier - docs/SENSORS-ACCESSIBILITY.md).
//
// Readings are shown as sentences where a sentence exists (a lidar scan is
// "nearest 0.9 m to the right"), never only as numbers or a picture.

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { popoutWindow } from "./api";
import RadarView from "./RadarView";
import {
  addSensorWatch, bridge, closeBridge, halted, lastFire, loadObservations, observations, observeSensor, openBridge,
  readingText, removeSensorWatch, resumeSensors, sensors, sourceLabel, startSensor, stopEverything, stopSensor,
  storedText, watches, watchRemainingMs,
  type SensorInfo, type WatchInfo,
} from "./sensorStore";

const SWEEP_MS = 600;

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour12: false });
}

export default function SensorsPanel() {
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal("");
  const [sweeping, setSweeping] = createSignal<string | null>(null);
  const [wSource, setWSource] = createSignal("");
  const [wQuestion, setWQuestion] = createSignal("");
  const [wEvery, setWEvery] = createSignal("5");
  const [wEveryUnit, setWEveryUnit] = createSignal<"s" | "min">("s");
  const [wFor, setWFor] = createSignal("2");
  const [wForUnit, setWForUnit] = createSignal<"s" | "min">("min");
  const [wWords, setWWords] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  let sourceSel: HTMLSelectElement | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let clockTimer: ReturnType<typeof setInterval> | undefined;

  // The picker's shown value IS its value. A <select value> set before its
  // options exist shows the first option while holding another (the real
  // window showed "Camera" over a watch on the simulated lidar), so it is
  // synced after render; and the first source is the default, never a
  // hard-coded id that may not exist.
  createEffect(() => {
    const list = sensors();
    if (!list.some((s) => s.id === wSource())) setWSource(list[0]?.id ?? "");
    if (sourceSel) sourceSel.value = wSource();
  });

  const stopSweep = (): void => { clearInterval(sweepTimer); sweepTimer = undefined; setSweeping(null); };
  onMount(() => {
    void loadObservations();
    clockTimer = setInterval(() => setNow(Date.now()), 1000);
  });
  onCleanup(() => { clearInterval(clockTimer); stopSweep(); });

  // A sweep is a live reading of a source that costs nothing to read (no
  // model call, nothing private). It ends by itself when the source stops or
  // the sensors are halted - it never keeps asking a stopped thing.
  createEffect(() => {
    const id = sweeping();
    if (id && (halted() || sensors().find((s) => s.id === id)?.state !== "live")) stopSweep();
  });
  const toggleSweep = (id: string): void => {
    if (sweeping() === id) { stopSweep(); return; }
    stopSweep();
    setSweeping(id);
    const tick = (): void => { void observeSensor(id); };
    tick();
    sweepTimer = setInterval(tick, SWEEP_MS);
  };

  const act = async (id: string, what: string, fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(id);
    try {
      const r = await fn();
      setNote(r.ok ? "" : `${what}: ${r.error ?? "did not work"}`);
    } finally { setBusy(""); }
  };
  const stateText = (s: SensorInfo): string => {
    if (halted()) return s.state === "live" ? "on, not observable" : "stopped";
    return s.state === "live" ? "live" : s.state;
  };

  const startWatch = async (e: Event): Promise<void> => {
    e.preventDefault();
    const mult = (u: "s" | "min"): number => (u === "min" ? 60_000 : 1000);
    const r = await addSensorWatch({
      sourceId: wSource(), question: wQuestion().trim() || undefined,
      everyMs: Number(wEvery()) * mult(wEveryUnit()), maxMs: Number(wFor()) * mult(wForUnit()),
      contains: wWords().split(",").map((w) => w.trim()).filter(Boolean).slice(0, 10),
    });
    setNote(r.ok ? "" : `Watch not started: ${r.error ?? "did not work"}`);
    if (r.ok) setWQuestion("");
  };

  return (
    <div class="sensors-panel">
      <div class="sensor-top">
        <Show when={!halted()} fallback={
          <>
            <p class="sensor-halted" role="status">Sensors are stopped. Nothing observes, watches or connects until you resume.</p>
            <button class="sensor-switch sensor-resume" onClick={() => void act("", "Resume", resumeSensors)}>Resume sensors</button>
          </>
        }>
          <button
            class="sensor-switch sensor-stop"
            title="The one switch: every source off, every watch removed, the bridge closed. Nothing observes until you resume. No confirmation needed - off is the safe state."
            onClick={() => void act("", "Stop", stopEverything)}
          >
            Stop everything
          </button>
        </Show>
        <span class="sensor-summary" role="status">
          {sensors().filter((s) => s.state === "live" || s.state === "starting").length} live{" \u00B7 "}{watches().length} watching{" \u00B7 "}bridge {bridge() ? "open" : "closed"}
        </span>
      </div>
      <Show when={note()}><p class="sensor-note" role="alert">{note()}</p></Show>

      <div class="sensor-columns">
        <div class="sensor-main">
          <h3>Sources</h3>
          <p class="sensor-hint">Every source is off until you start it. What the agent gets from any of them is one bounded observation per approved call - never a stream, pixels or points.</p>
          <ul class="sensor-list">
            <For each={sensors()}>{(s) => (
              <li class="sensor-row">
                <span class="sensor-dot" classList={{ "sensor-dot-live": s.state === "live" && !halted(), "sensor-dot-error": s.state === "error" }} aria-hidden="true" />
                <div class="sensor-info">
                  <strong>{s.label}</strong>
                  <span class="sensor-kind">{s.kind}{" \u00B7 "}{s.asks ? "each observation asks the model" : "no model call"}</span>
                  <Show when={s.desc}><div class="sensor-desc">{s.desc}</div></Show>
                </div>
                <span class="sensor-state">{stateText(s)}</span>
                <div class="sensor-actions">
                  <Show when={s.id === "camera"} fallback={
                    <Show when={s.state === "live"} fallback={
                      <button disabled={halted() || busy() === s.id} title="Start this source. Nothing reads it until you do." onClick={() => void act(s.id, "Start", () => startSensor(s.id))}>Start</button>
                    }>
                      <button disabled={busy() === s.id} onClick={() => void act(s.id, "Stop", () => stopSensor(s.id))}>Stop</button>
                    </Show>
                  }>
                    {/* The camera is started in its own window: the bus only reports it. */}
                    <button onClick={() => void popoutWindow("camera", "default")} title="Open the camera window - the camera runs only while that window is open and started there">Open camera window</button>
                  </Show>
                  <button
                    disabled={halted() || s.state !== "live" || busy() === s.id}
                    title={s.asks ? "One reading. For this source that is a model call on this machine." : "One reading. Free: no model call."}
                    onClick={() => void act(s.id, "Observe", () => observeSensor(s.id, ""))}
                  >
                    Observe
                  </button>
                  <Show when={!s.asks && s.state === "live" && !halted()}>
                    <button classList={{ "sensor-sweep-on": sweeping() === s.id }} title="Take a reading twice a second while this panel is open, so the Radar view moves. Free: this source makes no model call." onClick={() => toggleSweep(s.id)}>
                      {sweeping() === s.id ? "Sweeping\u2026 stop" : "Sweep"}
                    </button>
                  </Show>
                </div>
              </li>
            )}</For>
          </ul>

          <h3>Watches <span class="sensor-sub">- a standing question, asked on an interval, ending on its own</span></h3>
          <form class="sensor-watch-form" onSubmit={(e) => void startWatch(e)}>
            <span class="sensor-field sensor-field-grow">
              <span>Question (optional)</span>
              <input type="text" aria-label="Question (optional)" value={wQuestion()} onInput={(e) => setWQuestion(e.currentTarget.value)} placeholder="e.g. is a person visible?" maxLength={200} />
            </span>
            <span class="sensor-field">
              <span>of</span>
              <select
                ref={sourceSel}
                aria-label="Source to watch"
                // A change counts only when the picker has focus: Chromium can
                // fire one while rebuilding options, which is not a choice.
                onChange={(e) => { if (e.currentTarget === document.activeElement) setWSource(e.currentTarget.value); }}
              >
                <For each={sensors()}>{(s) => <option value={s.id}>{s.label}</option>}</For>
              </select>
            </span>
            <span class="sensor-field">
              <span>every</span>
              <span class="sensor-pair" role="group">
                <input type="number" min="1" step="1" value={wEvery()} onInput={(e) => setWEvery(e.currentTarget.value)} class="sensor-num" aria-label="Interval" />
                <select value={wEveryUnit()} onChange={(e) => setWEveryUnit(e.currentTarget.value as "s" | "min")} aria-label="Interval unit">
                  <option value="s">sec</option><option value="min">min</option>
                </select>
              </span>
            </span>
            <span class="sensor-field">
              <span>for</span>
              <span class="sensor-pair" role="group">
                <input type="number" min="1" step="1" value={wFor()} onInput={(e) => setWFor(e.currentTarget.value)} class="sensor-num" aria-label="Duration" />
                <select value={wForUnit()} onChange={(e) => setWForUnit(e.currentTarget.value as "s" | "min")} aria-label="Duration unit">
                  <option value="s">sec</option><option value="min">min</option>
                </select>
              </span>
            </span>
            <span class="sensor-field">
              <span>only if the reading mentions (optional)</span>
              <input type="text" aria-label="Only fire if the reading mentions (comma-separated)" value={wWords()} onInput={(e) => setWWords(e.currentTarget.value)} placeholder="person, door" />
            </span>
            <button type="submit" class="sensor-watch-start" disabled={halted()}>Start watch</button>
          </form>
          <p class="sensor-hint">
            At most every 2 seconds (each ask of a real sensor can be a model call), at most 30 minutes, at most 8 at once. A watch on the camera asks the local vision model each time.
          </p>
          <Show when={watches().length === 0}><p class="sensor-none">No watches.</p></Show>
          <ul class="sensor-watch-list">
            <For each={watches()}>{(w: WatchInfo) => (
              <li class="sensor-watch">
                <span class="sensor-dot sensor-dot-live" aria-hidden="true" />
                <div class="sensor-info">
                  <strong>{sourceLabel(w.sourceId)}</strong> {w.question ? `\u201C${w.question}\u201D` : <span class="sensor-sub">plain reading</span>}
                  <Show when={w.contains?.length}><span class="sensor-sub"> only if it mentions: {(w.contains ?? []).join(", ")}</span></Show>
                  <div class="sensor-desc">
                    every {w.everyMs / 1000} s{" \u00B7 "}ends in {mmss(watchRemainingMs(w, now()))}{" \u00B7 "}fired {w.fires}
                    <Show when={w.lastAt}>{" \u00B7 "}last at {clock(w.lastAt!)}</Show>
                  </div>
                  <Show when={w.lastText}><div class="sensor-last">last: {storedText(w.lastText)}</div></Show>
                </div>
                <button disabled={busy() === w.id} onClick={() => void act(w.id, "Remove watch", () => removeSensorWatch(w.id))}>Remove</button>
              </li>
            )}</For>
          </ul>

          <h3>Bridge <span class="sensor-sub">- for sidecars: a ROS 2 bridge, a scanner, a switch box</span></h3>
          <p class="sensor-hint">
            A sidecar connects on 127.0.0.1 with a token that is new each launch and never crosses the API: it is in <code>~/.eventhorizon/sensors.json</code>, readable by your user only. It can only push observations - never start, stop or watch anything.
          </p>
          <div class="checks">
            <Show when={bridge()} fallback={<button disabled={halted()} onClick={() => void act("bridge", "Open bridge", openBridge)}>Open bridge</button>}>
              <span class="sensor-bridge-on">Bridge open{" \u00B7 "}sidecars read <code>{bridge()!.infoFile}</code></span>
              <button onClick={() => void act("bridge", "Close bridge", closeBridge)}>Close bridge</button>
            </Show>
          </div>

          <h3>Recent observations <span class="sensor-sub">- in memory only, gone with the app</span></h3>
          <ol class="sensor-log">
            <For each={observations().slice(-8).reverse()}>{(o) => (
              <li><span class="sensor-log-t">{clock(o.t)}</span> <strong>{sourceLabel(o.source)}</strong> {readingText(o.payload, 110)}</li>
            )}</For>
          </ol>
        </div>

        <aside class="sensor-side">
          <h3>Radar</h3>
          <RadarView />
          <Show when={lastFire()}>{(f) => (
            <p class="sensor-fire" role="status">Last watch fire: <strong>{sourceLabel(f().observation.source)}</strong>{" \u2014 "}{readingText(f().observation.payload, 120)}</p>
          )}</Show>
        </aside>
      </div>
    </div>
  );
}
