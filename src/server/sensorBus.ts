// Event Horizon Code - the sensor bus (S3, N1-N3).
//
// docs/SENSORS.md §1-2, made real. Invariants encoded here:
//   - every sensor is OFF until the user turns it on (start), and reports
//     whether it is live; stopping releases it;
//   - the agent gets OBSERVATIONS, never streams: a bounded, structured
//     description produced on request or under a watch the user defined;
//   - retention is none: the only copy is a small in-memory ring for the UI;
//   - sensing is permission `ask` (tools gate it); actuation is a different
//     gate entirely (armed by the user, bounded, model-independent stop);
//   - peripherals talk to the bus through a token-gated loopback bridge, never
//     through a native module inside the app.
//
// Accessibility (docs/SENSORS-ACCESSIBILITY.md): a watch is a standing
// question a user who cannot type re-asks by existing; `stopAllSensors()` is
// the one switch that ends everything, whatever the model is doing.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { audit } from "./audit";

export type SensorKind = "device" | "process" | "bridge" | "serial" | "simulated";
export type SensorState = "off" | "starting" | "live" | "error";
export type Observation = { source: string; kind: string; t: number; seq: number; payload: unknown; ref?: string };
export type ObserveArgs = { question?: string; initiator: "user" | "agent" };

export type SensorSource = {
  id: string;
  label: string;
  kind: SensorKind;
  desc?: string;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
  /** Produces ONE bounded reading. Must never return raw video/point clouds/IQ. The bus stamps source, time and sequence. */
  observe: (args: ObserveArgs) => Promise<{ kind: string; payload: unknown; ref?: string }>;
  /** The live state when the source knows it better than the bus (the camera reports its window). */
  status?: () => SensorState;
  /** `false` only for sources that are not sensing (a pure simulator). */
  asks?: boolean;
};

export type SensorInfo = { id: string; label: string; kind: SensorKind; desc?: string; state: SensorState; asks: boolean; watches: number };

export type WatchSpec = { sourceId: string; question?: string; everyMs: number; maxMs: number; contains?: string[] };
export type Watch = WatchSpec & { id: string; startedAt: number; fires: number; lastAt: number | null; lastText: string | null; recent: Observation[] };
type LiveWatch = Watch & { timer?: NodeJS.Timeout; expiry?: NodeJS.Timeout };

const HISTORY_CAP = 200;
const MAX_WATCHES = 8;
const WATCH_MIN_EVERY_MS = 2000;
const WATCH_MAX_MS = 30 * 60_000;
const PAYLOAD_CAP = 64 * 1024;

const sources = new Map<string, SensorSource>();
const states = new Map<string, SensorState>();
const history: Observation[] = [];
const watches = new Map<string, LiveWatch>();
let seqCounter = 0;
const listeners = new Set<(o: Observation, meta?: { watchId?: string }) => void>();

export function onObservation(fn: (o: Observation, meta?: { watchId?: string }) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function registerSource(s: SensorSource): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(s.id)) throw new Error(`sensor id "${s.id}" must match [a-z0-9][a-z0-9_-]{0,39}`);
  sources.set(s.id, { ...s, asks: s.asks !== false });
  if (!states.has(s.id)) states.set(s.id, "off");
}
export function unregisterSource(id: string): void {
  const s = sources.get(id);
  if (s) void stopSource(id);
  for (const w of [...watches.values()]) if (w.sourceId === id) removeWatch(w.id);
  sources.delete(id);
  states.delete(id);
}

export function listSensors(): SensorInfo[] {
  return [...sources.values()].map((s) => ({
    id: s.id, label: s.label, kind: s.kind, desc: s.desc,
    state: s.status ? s.status() : (states.get(s.id) ?? "off"),
    asks: s.asks !== false,
    watches: [...watches.values()].filter((w) => w.sourceId === s.id).length,
  }));
}

export async function startSource(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = sources.get(id);
  if (!s) return { ok: false, error: `no sensor named "${id}"` };
  if ((s.status ? s.status() : states.get(id)) === "live") return { ok: true };
  states.set(id, "starting");
  try {
    if (s.start) await s.start();
    states.set(id, "live");
    audit({ tool: "sensor", note: `start ${id}` });
    return { ok: true };
  } catch (e) {
    states.set(id, "error");
    audit({ tool: "sensor", note: `start ${id} failed: ${String((e as Error).message ?? e).slice(0, 80)}` });
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
  }
}

export async function stopSource(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const s = sources.get(id);
  if (!s) return { ok: false, error: `no sensor named "${id}"` };
  try { if (s.stop) await s.stop(); } catch { /* released as far as it goes */ }
  states.set(id, "off");
  audit({ tool: "sensor", note: `stop ${id}` });
  return { ok: true };
}

function sized(o: Observation): Observation {
  const len = JSON.stringify(o.payload ?? null).length;
  if (len > PAYLOAD_CAP) return { ...o, payload: { truncated: true, bytes: len, note: "payload exceeded the bus cap and was dropped" } };
  return o;
}

/** The ONE way an observation enters the app: bounded, sequenced, timestamped, retention none. */
export function pushObservation(o: Omit<Observation, "t" | "seq">): Observation {
  const full: Observation = sized({ ...o, t: Date.now(), seq: ++seqCounter });
  history.push(full);
  if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
  for (const fn of listeners) { try { fn(full); } catch { /* a listener never breaks the bus */ } }
  return full;
}

export function recentObservations(source?: string, limit = 20): Observation[] {
  return history.filter((o) => !source || o.source === source).slice(-Math.max(1, Math.min(limit, HISTORY_CAP)));
}

export async function observeSource(id: string, args: ObserveArgs): Promise<{ ok: true; observation: Observation } | { ok: false; error: string }> {
  const s = sources.get(id);
  if (!s) return { ok: false, error: `no sensor named "${id}"` };
  const state = s.status ? s.status() : (states.get(id) ?? "off");
  if (state !== "live") return { ok: false, error: `sensor "${id}" is ${state} - start it first` };
  try {
    const raw = await s.observe(args);
    const observation = pushObservation({ source: id, kind: raw.kind ?? "observation", payload: raw.payload, ref: raw.ref });
    audit({ tool: "sensor.observe", note: `${id} ${observation.kind} by ${args.initiator} ${JSON.stringify(observation.payload ?? null).length}b` });
    return { ok: true, observation };
  } catch (e) {
    audit({ tool: "sensor.observe", note: `${id} failed: ${String((e as Error).message ?? e).slice(0, 80)}` });
    return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
  }
}

// ---- watches: a standing question, asked on an interval, bounded in time ----

export function addWatch(spec: WatchSpec): { ok: true; watch: Watch } | { ok: false; error: string } {
  const s = sources.get(spec.sourceId);
  if (!s) return { ok: false, error: `no sensor named "${spec.sourceId}"` };
  if (watches.size >= MAX_WATCHES) return { ok: false, error: `at most ${MAX_WATCHES} watches at a time` };
  if (!Number.isFinite(spec.everyMs) || spec.everyMs < WATCH_MIN_EVERY_MS) return { ok: false, error: `a watch asks at most every ${WATCH_MIN_EVERY_MS / 1000} s - each ask can be a model call` };
  if (!Number.isFinite(spec.maxMs) || spec.maxMs < spec.everyMs || spec.maxMs > WATCH_MAX_MS) return { ok: false, error: `a watch lasts between its interval and ${WATCH_MAX_MS / 60000} minutes` };
  const watch: LiveWatch = {
    ...spec, id: `watch_${crypto.randomUUID().slice(0, 8)}`, startedAt: Date.now(), fires: 0, lastAt: null, lastText: null, recent: [],
  };
  watch.timer = setInterval(() => { void tickWatch(watch); }, spec.everyMs);
  watch.timer.unref?.();
  // The deadline is its own timer, precise to the millisecond: a watch ends
  // at maxMs whether or not a tick happens to fall on it (the bus test caught
  // a 2.6 s watch living until its 4 s tick).
  watch.expiry = setTimeout(() => removeWatch(watch.id, "expired"), spec.maxMs);
  watch.expiry.unref?.();
  watches.set(watch.id, watch);
  audit({ tool: "sensor.watch", note: `add ${watch.id} on ${spec.sourceId} every ${spec.everyMs}ms for ${spec.maxMs}ms` });
  return { ok: true, watch };
}

async function tickWatch(w: LiveWatch): Promise<void> {
  if (!watches.has(w.id)) return; // removed or expired since this tick was queued
  const r = await observeSource(w.sourceId, { question: w.question, initiator: "user" });
  if (!r.ok) return; // a sensor that is off or failing simply yields nothing; the watch expires on time
  const text = typeof r.observation.payload === "string" ? r.observation.payload : JSON.stringify(r.observation.payload);
  if (w.contains?.length && !w.contains.some((c) => text.toLowerCase().includes(c.toLowerCase()))) return;
  w.fires++;
  w.lastAt = Date.now();
  w.lastText = text.slice(0, 2000);
  w.recent.push(r.observation);
  if (w.recent.length > 5) w.recent.shift();
  for (const fn of listeners) { try { fn(r.observation, { watchId: w.id }); } catch { /* never breaks the bus */ } }
}

export function removeWatch(id: string, why = "removed"): boolean {
  const w = watches.get(id);
  if (!w) return false;
  if (w.timer) clearInterval(w.timer);
  if (w.expiry) clearTimeout(w.expiry);
  watches.delete(id);
  audit({ tool: "sensor.watch", note: `${why} ${id} fires=${w.fires}` });
  return true;
}

export function listWatches(): Array<WatchSpec & { id: string; startedAt: number; fires: number; lastAt: number | null; lastText: string | null }> {
  return [...watches.values()].map(({ timer: _t, expiry: _e, recent: _r, ...w }) => w);
}

/** The one switch that ends everything: every source off, every watch gone. Never depends on the model. */
export async function stopAllSensors(): Promise<{ stopped: string[]; watchesRemoved: number }> {
  const stopped: string[] = [];
  for (const id of [...sources.keys()]) {
    const st = sources.get(id)!.status ? sources.get(id)!.status!() : (states.get(id) ?? "off");
    if (st !== "off") { await stopSource(id); stopped.push(id); }
  }
  let n = 0;
  for (const id of [...watches.keys()]) if (removeWatch(id, "stop-all")) n++;
  audit({ tool: "sensor", note: `stop-all: ${stopped.length} source(s), ${n} watch(es)` });
  return { stopped, watchesRemoved: n };
}

// ---- the simulated lidar: a LaserScan source with zero hardware ----

export function registerSimulatedLidar(): void {
  let phase = 0;
  registerSource({
    id: "sim-lidar", label: "Simulated lidar (36 sectors)", kind: "simulated", asks: false,
    desc: "A fake planar scan - proves the Radar panel and the bus with no hardware. Off until started.",
    observe: async () => {
      const sectors = Array.from({ length: 36 }, (_, i) => {
        const obstacle = i === 14 || i === 15 ? 0.9 : 1; // a static "wall" on one side
        return Math.round((3 + 2 * Math.sin(phase + (i / 36) * Math.PI * 2) + Math.cos(i * 1.7)) * 100 * obstacle) / 100;
      });
      phase += 0.15;
      return { kind: "laserscan", payload: { sectors, rangeM: 5, resolutionDeg: 10 }, ref: undefined };
    },
  });
}

// ---- the bridge (N3): a token-gated loopback listener for ROS 2 / sidecars ----

const BRIDGE_LINE_CAP = 256 * 1024;
const BRIDGE_RATE_PER_SEC = 20;
// Ids a bridge may never claim, whether or not the built-in is registered in
// this process: a sidecar that called itself "camera" would answer observes
// meant for the camera (found by the bus test - the guard used to protect only
// sources that happened to exist yet).
export const RESERVED_SOURCE_IDS: ReadonlySet<string> = new Set(["camera", "sim-lidar"]);
let bridge: { server: net.Server; port: number; token: string } | null = null;
const bridgeSockets = new Set<net.Socket>();

function bridgeInfoFile(): string {
  return path.join(os.homedir(), ".eventhorizon", "sensors.json");
}

export function bridgeRunning(): boolean {
  return bridge !== null;
}

export { bridgeInfoFile };

/** Starts the listener on first use. The token is random per launch and written owner-only for same-user sidecars. */
export function ensureBridgeListener(): Promise<{ port: number; token: string; infoFile: string }> {
  if (bridge) return Promise.resolve({ port: bridge.port, token: bridge.token, infoFile: bridgeInfoFile() });
  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(24).toString("hex");
    const server = net.createServer((socket) => handleBridgeConnection(socket, token));
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") { reject(new Error("bridge has no port")); return; }
      bridge = { server, port: addr.port, token };
      try {
        const file = bridgeInfoFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ port: addr.port, token, protocol: "ehc-bridge/1" }, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
        try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs apply by default */ }
      } catch (e) { audit({ tool: "sensor.bridge", note: `info file not written: ${String((e as Error).message).slice(0, 80)}` }); }
      audit({ tool: "sensor.bridge", note: `listening on 127.0.0.1:${addr.port}` });
      resolve({ port: addr.port, token, infoFile: bridgeInfoFile() });
    });
  });
}

function handleBridgeConnection(socket: net.Socket, token: string): void {
  let buffer = "";
  let sourceId = "";
  let label = "";
  let lastSecond = Date.now();
  let count = 0;
  bridgeSockets.add(socket);
  socket.on("close", () => bridgeSockets.delete(socket));
  const deny = (why: string): void => {
    audit({ tool: "sensor.bridge", note: `connection closed: ${why}` });
    try { socket.end(JSON.stringify({ type: "error", error: why }) + "\n"); } catch { /* gone */ }
    socket.destroy();
  };
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > BRIDGE_LINE_CAP) { deny("line over the size cap"); return; }
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { deny("not JSON"); return; }
      if (!sourceId) {
        if (msg.type !== "hello") { deny("first line must be a hello"); return; }
        const a = Buffer.from(String(msg.token ?? "")); const b = Buffer.from(token);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { deny("bad token"); return; }
        const id = String(msg.source ?? "");
        const taken = RESERVED_SOURCE_IDS.has(id) || (sources.has(id) && sources.get(id)!.kind !== "bridge");
        if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || taken) { deny("bad or taken source id"); return; }
        sourceId = id;
        label = String(msg.label ?? id).slice(0, 80);
        // State follows the connection (the states map), never a fixed answer:
        // a disconnected bridge is OFF, and observe then refuses honestly.
        registerSource({ id: sourceId, label, kind: "bridge", observe: async () => ({ kind: "observation", payload: recentObservations(sourceId, 1)[0]?.payload ?? null }) });
        states.set(sourceId, "live");
        audit({ tool: "sensor.bridge", note: `source ${sourceId} connected` });
        try { socket.write(JSON.stringify({ type: "welcome", source: sourceId }) + "\n"); } catch { /* gone */ }
        continue;
      }
      if (msg.type !== "observation") { deny("only observations after hello"); return; }
      const now = Date.now();
      if (now - lastSecond >= 1000) { lastSecond = now; count = 0; }
      if (++count > BRIDGE_RATE_PER_SEC) { deny("over the rate cap"); return; }
      pushObservation({ source: sourceId, kind: String(msg.kind ?? "observation").slice(0, 40), payload: msg.payload ?? null, ref: typeof msg.ref === "string" ? msg.ref.slice(0, 512) : undefined });
    }
  });
  socket.on("error", () => { /* closed below */ });
  socket.on("close", () => {
    if (sourceId && sources.get(sourceId)?.kind === "bridge") {
      states.set(sourceId, "off");
      audit({ tool: "sensor.bridge", note: `source ${sourceId} disconnected` });
    }
  });
}

export async function closeBridgeListener(): Promise<void> {
  if (!bridge) return;
  const b = bridge;
  bridge = null;
  // No straggler can hold the close open: every live connection is ended first.
  for (const s of bridgeSockets) { try { s.destroy(); } catch { /* gone */ } }
  bridgeSockets.clear();
  await new Promise<void>((res) => b.server.close(() => res()));
  try { fs.rmSync(bridgeInfoFile(), { force: true }); } catch { /* nothing to remove */ }
}
