// Sensor bus tests (S3 N1-N3) - offline: a loopback stub stands in for a
// bridge. Covers the registry, observations, watches, the model-independent
// stop, the simulated lidar, the token-gated bridge listener, and the
// `sensor_observe` tool gate.
// Run: npm run sensorbus:test

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  addWatch, closeBridgeListener, ensureBridgeListener, listSensors, listWatches, onObservation,
  observeSource, pushObservation, recentObservations, registerSimulatedLidar, registerSource,
  removeWatch, startSource, stopAllSensors, stopSource, unregisterSource,
} from "../src/server/sensorBus";
import { runTool } from "../src/server/tools";
import { alwaysAsks, callDigest, consumeGrant } from "../src/server/approvals";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("[ehc] sensor bus tests");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-sensorbus-"));
  process.env.EH_AUDIT_LOG = path.join(tmp, "audit.jsonl");
  process.env.USERPROFILE = tmp; process.env.HOME = tmp; // the bridge info file lands under the temp home

  // 1. The registry: off until started, id validation, status override.
  let started = 0, stopped = 0, asked = 0;
  registerSource({
    id: "stub", label: "Stub sensor", kind: "process",
    start: () => { started++; }, stop: () => { stopped++; },
    observe: async ({ question }) => { asked++; return { kind: "reading", payload: { value: asked, q: question ?? "" } }; },
  });
  check("a source id must be safe", (() => { try { registerSource({ id: "bad id!", label: "x", kind: "device", observe: async () => ({ kind: "x", payload: 1 }) }); return false; } catch { return true; } })());
  check("a source is off until started", listSensors().find((s) => s.id === "stub")?.state === "off");
  check("an off source yields a stated refusal, and asks nothing", !(await observeSource("stub", { initiator: "user" })).ok && asked === 0);
  check("an unknown source is refused", !(await startSource("nope")).ok && !(await observeSource("nope", { initiator: "user" })).ok);
  await startSource("stub");
  check("start runs the source's start and reports live", started === 1 && listSensors().find((s) => s.id === "stub")?.state === "live");
  check("a source with a status() reports that instead", (() => { registerSource({ id: "beats", label: "b", kind: "device", status: () => "live", observe: async () => ({ kind: "k", payload: 1 }) }); return listSensors().find((s) => s.id === "beats")?.state === "live"; })());
  // 2. Observations: sequenced, timestamped, bounded, retention none beyond a ring.
  const seen: string[] = [];
  const off = onObservation((o) => seen.push(o.source));
  const a = await observeSource("stub", { question: "hello?", initiator: "user" });
  const b = await observeSource("stub", { initiator: "agent" });
  check("an observation carries the question, a sequence and a timestamp", a.ok && b.ok && (a.observation.payload as { q: string }).q === "hello?" && b.observation.seq > a.observation.seq && b.observation.t >= a.observation.t);
  check("the source sees who asked", asked === 2);
  check("listeners hear every observation", seen.includes("stub") && seen.length >= 2);
  off();
  const big = pushObservation({ source: "stub", kind: "blob", payload: { text: "x".repeat(80_000) } });
  check("a payload over the cap is dropped, with its size stated", (big.payload as { truncated?: boolean }).truncated === true && JSON.stringify(big.payload).length < 500);
  for (let i = 0; i < 260; i++) pushObservation({ source: "stub", kind: "n", payload: i });
  check("history is a bounded ring (retention none beyond the UI's view)", recentObservations(undefined, 500).length === 200 && recentObservations("stub", 5).length === 5, `${recentObservations(undefined, 500).length}`);
  await stopSource("stub");
  check("stop runs the source's stop and reports off", stopped === 1 && listSensors().find((s) => s.id === "stub")?.state === "off");
  registerSource({ id: "boom", label: "b", kind: "process", start: () => { throw new Error("no device"); }, observe: async () => ({ kind: "k", payload: 1 }) });
  const boomStart = await startSource("boom");
  check("a failing start is a stated error, not a live sensor", !boomStart.ok && /no device/.test(boomStart.error) && listSensors().find((s) => s.id === "boom")?.state === "error");

  // 3. Watches: validated, bounded in time, filtered, and removable.
  registerSource({ id: "ticker", label: "Ticker", kind: "simulated", asks: false, observe: async () => ({ kind: "reading", payload: "a person is visible" }) });
  await startSource("ticker");
  check("a watch needs a real source", !(await Promise.resolve(addWatch({ sourceId: "ghost", everyMs: 5000, maxMs: 20000 }))).ok);
  check("a watch asks no faster than every 2 s", !addWatch({ sourceId: "ticker", everyMs: 500, maxMs: 20000 }).ok);
  check("a watch cannot outlive 30 minutes", !addWatch({ sourceId: "ticker", everyMs: 5000, maxMs: 31 * 60_000 }).ok);
  check("a watch cannot be shorter than its own interval", !addWatch({ sourceId: "ticker", everyMs: 5000, maxMs: 2000 }).ok);
  const w1 = addWatch({ sourceId: "ticker", everyMs: 2000, maxMs: 2600, contains: ["person"] });
  const w2 = addWatch({ sourceId: "ticker", everyMs: 2000, maxMs: 2600, contains: ["nobody-here"] });
  check("a watch is created with an id", w1.ok && w2.ok && listWatches().length === 2);
  const fires: string[] = [];
  const firedText: Record<string, string> = {};
  const offW = onObservation((o, meta) => { if (meta?.watchId) { fires.push(meta.watchId); firedText[meta.watchId] = JSON.stringify(o.payload); } });
  await sleep(3200);
  offW();
  check("a matching watch fired at least once and carried its text", fires.filter((id) => id === w1.watch!.id).length >= 1 && /person/.test(firedText[w1.watch!.id] ?? ""), JSON.stringify(firedText));
  check("a watch whose words never appear does not fire", !fires.includes(w2.watch!.id), JSON.stringify(fires));
  check("watch fires reach listeners with the watch id", fires.includes(w1.watch!.id) && !fires.includes(w2.watch!.id));
  check("a watch expires on its own clock (bounded in time)", listWatches().length === 0, JSON.stringify(listWatches().map((w) => w.id)));
  for (let i = 0; i < 8; i++) addWatch({ sourceId: "ticker", everyMs: 5000, maxMs: 20000 });
  check("at most 8 watches at a time", !addWatch({ sourceId: "ticker", everyMs: 5000, maxMs: 20000 }).ok && listWatches().length === 8);
  const firstWatch = listWatches()[0]!.id;
  check("a watch can be removed by id, and only once", removeWatch(firstWatch) && !removeWatch(firstWatch) && listWatches().length === 7);

  // 4. The one switch: everything off, every watch gone, whatever the model is doing.
  const all = await stopAllSensors();
  check("stop-all stops every live source and removes every watch", all.stopped.includes("ticker") && all.stopped.includes("beats") && all.watchesRemoved === 7 && listWatches().length === 0 && listSensors().every((s) => s.state !== "live" || s.id === "beats"), JSON.stringify(all));
  unregisterSource("stub"); unregisterSource("boom"); unregisterSource("ticker"); unregisterSource("beats");

  // 5. The simulated lidar: a planar scan with zero hardware.
  registerSimulatedLidar();
  check("the simulated lidar is off until started and does not ask", listSensors().find((s) => s.id === "sim-lidar")?.state === "off" && listSensors().find((s) => s.id === "sim-lidar")?.asks === false);
  await startSource("sim-lidar");
  const scan = await observeSource("sim-lidar", { initiator: "user" });
  const sectors = (scan.ok ? (scan.observation.payload as { sectors: number[] }).sectors : []);
  check("it yields 36 bounded sectors in metres", scan.ok && scan.observation.kind === "laserscan" && sectors.length === 36 && sectors.every((v) => Number.isFinite(v) && v >= 0 && v <= 6), JSON.stringify(sectors.slice(0, 6)));
  await stopSource("sim-lidar");

  // 6. The bridge: a token-gated loopback listener. A real TCP client plays the sidecar.
  const info = await ensureBridgeListener();
  check("the bridge listens on loopback and writes its info file for same-user sidecars", info.port > 0 && info.token.length >= 32 && fs.existsSync(info.infoFile) && JSON.parse(fs.readFileSync(info.infoFile, "utf8")).port === info.port);
  const connect = (): { sock: net.Socket; lines: string[]; closed: Promise<void> } => {
    const sock = net.connect(info.port, "127.0.0.1");
    sock.setEncoding("utf8");
    const lines: string[] = [];
    let buf = "";
    sock.on("data", (d: string) => { buf += d; let i: number; while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    const closed = new Promise<void>((r) => { sock.on("close", () => r()); sock.on("error", () => r()); });
    return { sock, lines, closed };
  };
  const send = (c: { sock: net.Socket }, o: unknown): void => { c.sock.write(JSON.stringify(o) + "\n"); };
  const bad = connect();
  send(bad, { type: "hello", token: "wrong", source: "lidar" });
  await Promise.race([bad.closed, sleep(3000)]);
  check("a wrong token closes the connection", bad.sock.destroyed, bad.lines.join("|"));
  check("nothing was registered for the refused connection", !listSensors().some((s) => s.id === "lidar"));

  const good = connect();
  send(good, { type: "hello", token: info.token, source: "lidar", label: "RPLIDAR C1" });
  await sleep(300);
  check("a correct hello is welcomed and the source appears live", good.lines.some((l) => /welcome/.test(l)) && listSensors().some((s) => s.id === "lidar" && s.state === "live" && s.kind === "bridge"), good.lines.join("|"));
  send(good, { type: "observation", kind: "laserscan", payload: { sectors: [1, 2, 3] } });
  send(good, { type: "observation", kind: "battery", payload: { volts: 12.1 }, ref: "pack-a" });
  await sleep(300);
  const pushed = recentObservations("lidar", 5);
  check("pushed observations enter the bus with their kind and ref", pushed.length === 2 && pushed[0]!.kind === "laserscan" && pushed[1]!.ref === "pack-a" && pushed.every((o) => o.source === "lidar"));
  const lidarAsk = await observeSource("lidar", { initiator: "user" });
  check("a bridge source answers an observe with its latest reading", lidarAsk.ok && JSON.stringify(lidarAsk.observation.payload).includes("volts"));
  send(good, { type: "hello", token: info.token, source: "x" });
  await Promise.race([good.closed, sleep(2000)]);
  check("only observations are accepted after hello", good.sock.destroyed, good.lines.join("|"));

  const taken = connect();
  send(taken, { type: "hello", token: info.token, source: "camera" });
  await Promise.race([taken.closed, sleep(2000)]);
  check("a bridge cannot claim a built-in source id", taken.sock.destroyed && !listSensors().some((s) => s.id === "camera" && s.kind === "bridge"));
  const oversize = connect();
  send(oversize, { type: "hello", token: info.token, source: "big" });
  await sleep(200);
  oversize.sock.write("x".repeat(300 * 1024));
  await Promise.race([oversize.closed, sleep(2000)]);
  check("a line over the size cap closes the connection", oversize.sock.destroyed);
  const flood = connect();
  send(flood, { type: "hello", token: info.token, source: "flood" });
  await sleep(200);
  for (let i = 0; i < 25; i++) send(flood, { type: "observation", kind: "n", payload: i });
  await Promise.race([flood.closed, sleep(2000)]);
  check("a flood past the rate cap is closed, with at most 20 accepted", flood.sock.destroyed && recentObservations("flood", 50).length <= 20, String(recentObservations("flood", 50).length));
  good.sock.destroy();
  taken.sock.destroy(); oversize.sock.destroy(); flood.sock.destroy();
  const again = connect();
  send(again, { type: "hello", token: info.token, source: "lidar" });
  await sleep(250);
  check("a bridge source can reconnect after its connection was closed", listSensors().some((s) => s.id === "lidar" && s.state === "live" && s.kind === "bridge"));
  again.sock.destroy();
  await sleep(250);
  check("a disconnected bridge reports off (state follows the connection)", listSensors().find((s) => s.id === "lidar")?.state === "off");
  const gone = await observeSource("lidar", { initiator: "user" });
  check("observe on a disconnected bridge is a stated refusal", !gone.ok && /off - start it first/.test(gone.error));
  await closeBridgeListener();
  check("closing the bridge removes its info file", !fs.existsSync(info.infoFile));

  // 7. The agent's handle: `sensor_observe` asks on every use and cannot start anything.
  await startSource("sim-lidar");
  const denied = await runTool("sensor_observe", { source: "sim-lidar" }, process.cwd(), {});
  check("sensor_observe is permission ask (nothing without approval)", denied.ok === false && denied.needsApproval === true);
  const okRead = await runTool("sensor_observe", { source: "sim-lidar", question: "nearest obstacle?" }, process.cwd(), { userApproved: true });
  check("approved, it returns one bounded observation as text/JSON", okRead.ok === true && /sectors/.test(okRead.out), okRead.out.slice(0, 80));
  await stopSource("sim-lidar");
  const offRead = await runTool("sensor_observe", { source: "sim-lidar" }, process.cwd(), { userApproved: true });
  check("an off source is a stated refusal even when approved", offRead.ok === false && /off - start it first/.test(offRead.error ?? ""), offRead.error);
  check("sensing is in the always-ask floor (a grant can never cover it)", alwaysAsks("sensor_observe") && alwaysAsks("camera_look") && consumeGrant("s", "sensor_observe", callDigest("sensor_observe", { source: "camera" })) === null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "[ehc] sensor bus tests: ALL PASS" : `[ehc] sensor bus tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] sensor bus tests crashed:", e); process.exit(1); });
