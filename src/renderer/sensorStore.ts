// Event Horizon Code — the sensor bus as the renderer sees it.
//
// One place holds the sources, the watches and the latest observations. The
// Sensors panel, the Radar view and the status bar all read it, so the
// always-reachable stop and the panel can never disagree about what is on.
// The event stream keeps it current; a slow poll is the catch-up for changes
// made in another window or while the stream was down.
//
// The lists live in a store reconciled BY ID: a source or watch keeps its
// row across every poll and every fire. Rebuilding rows stole keyboard focus
// from a button inside them, and reset the watch form's picker.

import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { apiJson } from "./api";
import { asLaserScan, describeScan } from "../shared/radar";

export type SensorState = "off" | "starting" | "live" | "error";
export type SensorInfo = { id: string; label: string; kind: string; desc?: string; state: SensorState; asks: boolean; watches: number };
export type WatchInfo = {
  id: string; sourceId: string; question?: string; everyMs: number; maxMs: number; contains?: string[];
  startedAt: number; fires: number; lastAt: number | null; lastText: string | null;
};
export type Observation = { source: string; kind: string; t: number; seq: number; payload: unknown; ref?: string };
export type BridgeInfo = { protocol: string; infoFile: string } | null;
export type BusResult = { ok: boolean; error?: string; halted?: boolean };

const OBSERVATION_CAP = 60;
const TOAST_PER_WATCH_MS = 10_000;

const [bus, setBus] = createStore<{ sensors: SensorInfo[]; watches: WatchInfo[]; halted: boolean; bridge: BridgeInfo }>({
  sensors: [], watches: [], halted: false, bridge: null,
});
const [observations, setObservations] = createSignal<Observation[]>([]);
/** The most recent watch fire, for the panel's log. */
const [lastFire, setLastFire] = createSignal<{ watchId: string; observation: Observation } | null>(null);

const sensors = (): SensorInfo[] => bus.sensors;
const watches = (): WatchInfo[] => bus.watches;
const halted = (): boolean => bus.halted;
const bridge = (): BridgeInfo => bus.bridge;

export { sensors, watches, halted, bridge, observations, lastFire };

export function liveCount(): number {
  return sensors().filter((s) => s.state === "live" || s.state === "starting").length;
}
export function watchCount(): number {
  return watches().length;
}
export function sourceLabel(id: string): string {
  return sensors().find((s) => s.id === id)?.label ?? id;
}
/** The newest well-formed lidar scan, from any source. */
export function latestScan(): { observation: Observation; source: SensorInfo | undefined } | null {
  const all = observations();
  for (let i = all.length - 1; i >= 0; i--) {
    const o = all[i]!;
    if (o.kind === "laserscan" && asLaserScan(o.payload)) return { observation: o, source: sensors().find((s) => s.id === o.source) };
  }
  return null;
}
export function watchRemainingMs(w: WatchInfo, now: number): number {
  return Math.max(0, w.startedAt + w.maxMs - now);
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}\u2026` : s);

/** A reading as a person reads it. A lidar scan becomes its sentence (the same one the Radar view shows); never a raw dump where words exist. */
export function readingText(payload: unknown, max = 140): string {
  const scan = asLaserScan(payload);
  if (scan) return clip(describeScan(scan), max);
  if (typeof payload === "string") return clip(payload, max);
  if (payload && typeof payload === "object" && typeof (payload as { text?: unknown }).text === "string") return clip((payload as { text: string }).text, max);
  return clip(JSON.stringify(payload) ?? "", max);
}
/** The text a watch stored (JSON for object readings), as a person reads it. */
export function storedText(text: string | null, max = 140): string {
  if (!text) return "";
  try { return readingText(JSON.parse(text), max); } catch { return clip(text, max); }
}

function appendObservation(o: Observation): void {
  setObservations((prev) => {
    // The same observation arrives twice when this window asked for it: once
    // in the answer, once on the stream. Sequence and time together identify it.
    if (prev.some((p) => p.seq === o.seq && p.t === o.t)) return prev;
    return [...prev, o].slice(-OBSERVATION_CAP);
  });
}

export async function refreshSensors(): Promise<void> {
  try {
    const d = await apiJson<{ sensors?: SensorInfo[]; watches?: WatchInfo[]; halted?: boolean; bridge?: BridgeInfo }>("/api/sensors");
    setBus("sensors", reconcile(d.sensors ?? [], { key: "id" }));
    setBus("watches", reconcile(d.watches ?? [], { key: "id" }));
    setBus("halted", d.halted === true);
    setBus("bridge", d.bridge ?? null);
  } catch { /* runtime not answering: what is shown stays what was last known */ }
}

/** Observations already in the bus's ring - the Radar view starts with history, not blank. */
export async function loadObservations(): Promise<void> {
  try {
    const d = await apiJson<{ observations?: Observation[] }>("/api/sensors/observations?limit=60");
    setObservations((d.observations ?? []).slice(-OBSERVATION_CAP));
  } catch { /* nothing yet */ }
}

const toastTimes = new Map<string, number>();
/** A `sensor` event off the stream. Every window receives every one. */
export function handleSensorEvent(e: { kind?: string; observation?: Observation; watchId?: string; id?: string }): void {
  const kind = e.kind ?? "";
  if (e.observation !== undefined) {
    // An observation event. `kind` is "observation", or "watch" when it came
    // from a watch; the payload distinguishes them, because the bus itself
    // also emits kind "watch" (a watch added/removed/expired, no payload).
    appendObservation(e.observation);
    if (kind === "watch" && e.watchId) {
      const o = e.observation;
      const text = typeof o.payload === "string" ? o.payload : JSON.stringify(o.payload);
      setBus("watches", (w) => w.id === e.watchId, "fires", (n) => n + 1);
      setBus("watches", (w) => w.id === e.watchId, "lastAt", o.t);
      setBus("watches", (w) => w.id === e.watchId, "lastText", text.slice(0, 2000));
      setLastFire({ watchId: e.watchId, observation: o });
      // The visual alert channel. One toast per watch every 10 s: eight
      // watches on a 2 s interval must not become four toasts a second.
      const now = Date.now();
      if (now - (toastTimes.get(e.watchId) ?? 0) >= TOAST_PER_WATCH_MS) {
        toastTimes.set(e.watchId, now);
        const w = watches().find((x) => x.id === e.watchId);
        const label = w?.question?.trim() || sourceLabel(o.source);
        window.dispatchEvent(new CustomEvent("ehc-toast", { detail: { text: `Watch fired \u2014 ${clip(label, 80)}: ${readingText(o.payload, 110)}`, kind: "ok" } }));
      }
    }
    return;
  }
  // state | watch | halt | bridge: the bus itself changed - read it again.
  void refreshSensors();
}

let pollTimer: ReturnType<typeof setInterval> | undefined;
let lastPoll = 0;
/** One poll per window, started by whoever shows the status bar. */
export function ensureSensorPolling(): void {
  if (pollTimer) return;
  void refreshSensors();
  pollTimer = setInterval(() => {
    const busy = halted() || liveCount() > 0 || watchCount() > 0;
    if (busy || Date.now() - lastPoll >= 10_000) void refreshSensors();
    lastPoll = Date.now();
  }, 4000);
}

async function call<T extends BusResult>(path: string, body?: unknown): Promise<T> {
  try {
    const r = await apiJson<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
    void refreshSensors();
    return r;
  } catch (e) {
    return { ok: false, error: `the runtime is not answering (${String((e as Error)?.message ?? e).slice(0, 80)})` } as T;
  }
}

export function startSensor(id: string): Promise<BusResult> {
  return call(`/api/sensors/${encodeURIComponent(id)}/start`);
}
export function stopSensor(id: string): Promise<BusResult> {
  return call(`/api/sensors/${encodeURIComponent(id)}/stop`);
}
/** One bounded observation, this window's user asking. */
export async function observeSensor(id: string, question = ""): Promise<BusResult & { observation?: Observation }> {
  const r = await call<BusResult & { observation?: Observation }>(`/api/sensors/${encodeURIComponent(id)}/observe`, { question });
  if (r.ok && r.observation) appendObservation(r.observation);
  return r;
}
/** The one switch. Never asks for confirmation: off is the safe state, and a dialog is a barrier. */
export function stopEverything(): Promise<BusResult & { stopped?: string[]; watchesRemoved?: number }> {
  return call("/api/sensors/stop-all");
}
export function resumeSensors(): Promise<BusResult> {
  return call("/api/sensors/resume");
}
export function addSensorWatch(spec: { sourceId: string; question?: string; everyMs: number; maxMs: number; contains?: string[] }): Promise<BusResult> {
  return call(`/api/sensors/${encodeURIComponent(spec.sourceId)}/watch`, spec);
}
export async function removeSensorWatch(id: string): Promise<BusResult> {
  try {
    const r = await apiJson<BusResult>(`/api/sensors/watches/${encodeURIComponent(id)}`, { method: "DELETE" });
    void refreshSensors();
    return r;
  } catch (e) {
    return { ok: false, error: `the runtime is not answering (${String((e as Error)?.message ?? e).slice(0, 80)})` };
  }
}
export function openBridge(): Promise<BusResult & { port?: number; infoFile?: string }> {
  return call("/api/sensors/bridge/open");
}
export function closeBridge(): Promise<BusResult> {
  return call("/api/sensors/bridge/close");
}
