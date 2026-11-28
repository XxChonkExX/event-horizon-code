// Sensor bus tests (S3 N1-N3) - offline: a loopback stub stands in for a
// bridge. Covers the registry, observations, watches, the model-independent
// stop (and the halt it sets), the simulated lidar, the token-gated bridge
// listener, the `sensor_observe` tool gate, and the radar geometry.
// Run: npm run sensorbus:test

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  HALTED_NOTE, addWatch, bridgeRunning, closeBridgeListener, ensureBridgeListener, listSensors, listStdioSources, listWatches,
  onBusEvent, onObservation, observeSource, pushObservation, recentObservations, registerSimulatedLidar, registerSource,
  registerStdioSource, removeWatch, resumeSensors, sensorsHalted, startSource, stopAllSensors, stopSource, unregisterSource, unregisterStdioSource,
} from "../src/server/sensorBus";
import { runTool } from "../src/server/tools";
import { alwaysAsks, callDigest, consumeGrant } from "../src/server/approvals";
import { lookFromCamera } from "../src/server/sensors";
import { asLaserScan, describeScan, nearestSector, ringRadii, wedgePath } from "../src/shared/radar";

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
  // The answer must survive the trip over HTTP: the live object carries Node
  // timer handles, and serialising it threw - a successful create answered
  // "400 bad request" (found by the real-window drive).
  const w1keys = w1.ok ? Object.keys(w1.watch).sort().join(",") : "";
  check("a created watch is returned in its public shape (serialisable, same fields as the listing)", w1.ok && !/timer|expiry|_idle/.test(w1keys) && (() => { try { JSON.stringify(w1.watch); return true; } catch { return false; } })() && w1keys === [...Object.keys(listWatches()[0]!), "recent"].sort().join(","), w1keys);
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

  // 4. The one switch: everything off, every watch gone - and HALTED, so
  //    nothing observes afterwards either. Whatever the model is doing.
  registerSource({ id: "win-owned", label: "Window-owned", kind: "device", status: () => "off", observe: async () => ({ kind: "k", payload: 1 }) });
  const events: string[] = [];
  const offBus = onBusEvent((e) => events.push(e.kind));
  const all = await stopAllSensors();
  offBus();
  check("stop-all stops every live source and removes every watch", all.stopped.includes("ticker") && all.stopped.includes("beats") && all.watchesRemoved === 7 && listWatches().length === 0 && listSensors().every((s) => s.state !== "live" || s.id === "beats"), JSON.stringify(all));
  check("stop-all halts the bus, and the UI hears it", sensorsHalted() === true && events.includes("state") && events.includes("watch") && events.includes("halt"), JSON.stringify(events));
  const hStart = await startSource("ticker");
  const hWatch = addWatch({ sourceId: "ticker", everyMs: 5000, maxMs: 20000 });
  const hObserve = await observeSource("beats", { initiator: "user" });
  check("while halted nothing starts, watches or observes - even a source that is on", hStart.halted === true && hWatch.halted === true && hObserve.halted === true && !listSensors().some((s) => s.id === "ticker" && s.state === "live") && listWatches().length === 0);
  check("the halt says the same thing everywhere", hStart.error === HALTED_NOTE && hWatch.error === HALTED_NOTE && hObserve.error === HALTED_NOTE);
  const hLook = await lookFromCamera({ question: "what is this?", initiator: "agent" });
  check("while halted the agent's camera look is refused before any frame is requested", !hLook.ok && /stopped by the user/.test(hLook.error ?? ""), hLook.error);
  const hBridge = await ensureBridgeListener();
  check("while halted no bridge can be opened", hBridge.halted === true && !bridgeRunning());
  resumeSensors();
  const rStart = await startSource("ticker");
  check("resume lifts the halt and nothing starts by itself", sensorsHalted() === false && rStart.ok === true && listWatches().length === 0);
  await stopSource("ticker");
  const winStart = await startSource("win-owned");
  check("a source that belongs to its window is not started from the bus", !winStart.ok && /open that window instead/.test(winStart.error ?? ""), winStart.error);
  unregisterSource("stub"); unregisterSource("boom"); unregisterSource("ticker"); unregisterSource("beats"); unregisterSource("win-owned");

  // 5. The simulated lidar: a planar scan with zero hardware.
  registerSimulatedLidar();
  check("the simulated lidar is off until started and does not ask", listSensors().find((s) => s.id === "sim-lidar")?.state === "off" && listSensors().find((s) => s.id === "sim-lidar")?.asks === false);
  await startSource("sim-lidar");
  const scan = await observeSource("sim-lidar", { initiator: "user" });
  const sectors = (scan.ok ? (scan.observation.payload as { sectors: number[] }).sectors : []);
  check("it yields 36 bounded sectors in metres", scan.ok && scan.observation.kind === "laserscan" && sectors.length === 36 && sectors.every((v) => Number.isFinite(v) && v >= 0 && v <= 6), JSON.stringify(sectors.slice(0, 6)));
  await stopSource("sim-lidar");

  // 6. The bridge: a token-gated loopback listener. A real TCP client plays the sidecar.
  const opened = await ensureBridgeListener();
  if (!opened.ok) throw new Error(`the bridge did not open: ${opened.error}`);
  const info = opened;
  check("the bridge listens on loopback and writes its info file for same-user sidecars", info.port > 0 && info.token.length >= 32 && fs.existsSync(info.infoFile) && JSON.parse(fs.readFileSync(info.infoFile, "utf8")).port === info.port);
  const connect = (port: number = info.port): { sock: net.Socket; lines: string[]; closed: Promise<void> } => {
    const sock = net.connect(port, "127.0.0.1");
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
  // 6b. Stopping is true for a bridge: the sidecar's connection ends with it.
  const solo = connect();
  send(solo, { type: "hello", token: info.token, source: "switch", label: "Switch box" });
  await sleep(250);
  check("a second sidecar connects while the listener is open", listSensors().some((s) => s.id === "switch" && s.state === "live"));
  await stopSource("switch");
  await Promise.race([solo.closed, sleep(2000)]);
  check("stopping a bridge source ends its connection, so off is true", solo.sock.destroyed && listSensors().find((s) => s.id === "switch")?.state === "off");
  const dualA = connect();
  send(dualA, { type: "hello", token: info.token, source: "dual" });
  await sleep(150);
  const dualB = connect();
  send(dualB, { type: "hello", token: info.token, source: "dual" });
  await Promise.race([dualA.closed, sleep(2000)]);
  await sleep(150);
  check("a new connection for the same id replaces the old one", dualA.sock.destroyed && listSensors().find((s) => s.id === "dual")?.state === "live");
  dualB.sock.destroy();
  await sleep(200);
  check("the owner leaving is what reports a bridge source off", listSensors().find((s) => s.id === "dual")?.state === "off");
  await closeBridgeListener();
  check("closing the bridge removes its info file", !fs.existsSync(info.infoFile));

  // 6c. The one switch reaches the bridge: listener closed, sidecars dropped,
  //     token file gone - and it stays shut while halted.
  const reopened = await ensureBridgeListener();
  if (!reopened.ok) throw new Error(`the bridge did not reopen: ${reopened.error}`);
  // A reopened listener has a NEW port: dial that one, not the closed one.
  const dropped = connect(reopened.port);
  send(dropped, { type: "hello", token: reopened.token, source: "robot", label: "ROS 2 bridge" });
  await sleep(250);
  check("the sidecar is connected before the switch", listSensors().some((s) => s.id === "robot" && s.state === "live"));
  const sw = await stopAllSensors();
  await Promise.race([dropped.closed, sleep(2000)]);
  const late = await ensureBridgeListener();
  check("stop-all closes the bridge, drops every sidecar and removes the token file", sw.bridgeClosed === true && !bridgeRunning() && !fs.existsSync(info.infoFile) && dropped.sock.destroyed && listSensors().find((s) => s.id === "robot")?.state === "off", JSON.stringify(sw));
  check("and the bridge stays shut until the user resumes", late.halted === true && !bridgeRunning());
  resumeSensors();

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

  // 7b. A simulator's reading writes no audit line (a live sweep would rotate
  //     the 5 MB log several times a day); a real sensor's reading does.
  const auditLines = (): number => { try { return fs.readFileSync(path.join(tmp, "audit.jsonl"), "utf8").split("\n").filter((l) => l.includes('"tool":"sensor.observe"')).length; } catch { return 0; } };
  registerSource({ id: "real-stub", label: "Real stub", kind: "device", observe: async () => ({ kind: "reading", payload: "ok" }) });
  await startSource("sim-lidar"); await startSource("real-stub");
  const a0 = auditLines();
  await observeSource("sim-lidar", { initiator: "user" });
  const simReading = await observeSource("sim-lidar", { initiator: "user" });
  const a1 = auditLines();
  await observeSource("real-stub", { initiator: "agent" });
  check("a simulator's reading writes no audit line; a real sensor's does", a1 === a0 && auditLines() === a0 + 1, `${a0} -> ${a1} -> ${auditLines()}`);
  await stopSource("sim-lidar"); await stopSource("real-stub"); unregisterSource("real-stub");

  // 8. Radar geometry: one function feeds the picture and the words, so the
  //    nearest obstacle the dial highlights is the one the sentence names.
  const wall = Array.from({ length: 36 }, (_, i) => (i === 15 ? 0.9 : 3 + i * 0.01));
  const dial = asLaserScan({ sectors: wall, rangeM: 5, resolutionDeg: 10 });
  check("a scan is read; a malformed one is refused, never guessed", !!dial && asLaserScan(null) === null && asLaserScan({ sectors: [1, "x", 3, 4] }) === null && asLaserScan({ sectors: [1, -2, 3, 4] }) === null && asLaserScan({ sectors: [1, 2] }) === null && asLaserScan({ sectors: [1, NaN, 3, 4] }) === null);
  const near = dial ? nearestSector(dial) : null;
  check("the nearest sector is found with its bearing (clockwise from ahead)", !!near && near.index === 15 && near.bearingDeg === 155, JSON.stringify(near));
  const words = dial ? describeScan(dial, "Sim lidar") : "";
  check("the reading in words names the same obstacle", words === "Sim lidar: nearest 0.90 m behind right (155\u00B0, sector 16 of 36, 5 m range)", words);
  const sides = (deg: number): string => { const s = asLaserScan({ sectors: Array.from({ length: 360 }, (_, i) => (i === deg ? 0.5 : 4)), resolutionDeg: 1 }); return s ? describeScan(s).replace(/.*m ([a-z ]+) \(.*/, "$1") : "?"; };
  check("every direction reads as a side of the machine, not a bare angle", [0, 45, 90, 135, 180, 225, 270, 315, 350].map(sides).join("|") === "ahead|ahead right|to the right|behind right|behind|behind left|to the left|ahead left|ahead", [0, 45, 90, 135, 180, 225, 270, 315, 350].map(sides).join("|"));
  const p = wedgePath(120, 120, 12, 108, 0, 10);
  check("a wedge starts straight ahead (up) and runs clockwise", p.startsWith("M 120.00 12.00 A 108 108 0 0 1 138.75 13.64 ") && p.endsWith("Z"), p);
  const rings = ringRadii(108, 5);
  check("range rings are equal fractions, each labelled in metres", rings.map((r) => r.r).join(",") === "27,54,81,108" && rings[3]!.metres === 5, JSON.stringify(rings));
  check("the simulated lidar's payload is a well-formed scan for the dial", simReading.ok && !!asLaserScan(simReading.observation.payload));

  // 9. stdio sidecar sources (N3): operator-configured tool, app-spawned, JSON Lines.
  process.env.EH_PASS = "sidecar-must-not-see-this";
  const sidecarScript = path.join(tmp, "sidecar.cjs");
  const sidecarLines = [
    `JSON.stringify({ kind: "laserscan", payload: { sectors: [1, 2, 3] } })`,
    `"not json at all"`,
    `JSON.stringify({ kind: "env", payload: { ehpass: process.env.EH_PASS === undefined, auditlog: process.env.EH_AUDIT_LOG === undefined } })`,
    `JSON.stringify({ kind: "reading", payload: "second reading", ref: "pack-b" })`,
  ];
  fs.writeFileSync(sidecarScript, `const lines = [\n${sidecarLines.join(",\n")}\n];\nfor (const l of lines) process.stdout.write(l + "\\n");\nsetTimeout(() => {}, 30000);\n`);
  const reg = registerStdioSource({ id: "sidecar", label: "Test sidecar", command: process.execPath, args: [sidecarScript], cwd: tmp, desc: "test sidecar" });
  check("a stdio source registers + spawns live", reg.ok === true && listSensors().find((s) => s.id === "sidecar")?.state === "live" && listStdioSources()[0]?.id === "sidecar");
  await sleep(800);
  const sc = recentObservations("sidecar", 10);
  check("sidecar JSON Lines become observations (bad JSON dropped)", sc.length === 3 && sc[0]!.kind === "laserscan" && sc[2]!.kind === "reading" && sc[2]!.ref === "pack-b", JSON.stringify(sc.map((o) => o.kind)));
  const envObs = sc.find((o) => o.kind === "env");
  const envPayload = envObs ? (envObs.payload as { ehpass: boolean; auditlog: boolean }) : null;
  check("sidecar env is scrubbed (no EH_PASS, no EH_AUDIT_LOG)", envPayload?.ehpass === true && envPayload?.auditlog === true, JSON.stringify(envPayload));
  const scAsk = await runTool("sensor_observe", { source: "sidecar" }, process.cwd(), {});
  check("agent can observe a live stdio source only via ask", scAsk.ok === false && scAsk.needsApproval === true);
  const scAgain = registerStdioSource({ id: "sidecar", label: "dupe", command: process.execPath });
  check("a duplicate id is refused", scAgain.ok === false && /already exists/.test(scAgain.error ?? ""));
  await stopAllSensors();
  const scHaltRef = registerStdioSource({ id: "post-halt", label: "x", command: process.execPath });
  check("a stdio source cannot be registered while halted", scHaltRef.ok === false && (scHaltRef as { halted?: boolean }).halted === true);
  resumeSensors();
  unregisterStdioSource("sidecar");
  check("stop-all + unregister leave no sidecar behind", !listSensors().some((s) => s.id === "sidecar") && listStdioSources().length === 0);
  // rate cap: a sidecar that floods is stopped, not trusted
  delete process.env.EH_PASS;
  const floodScript = path.join(tmp, "flood.cjs");
  fs.writeFileSync(floodScript, `for (let i = 0; i < 40; i++) process.stdout.write(JSON.stringify({ kind: "flood", payload: i }) + "\\n");\nsetTimeout(() => {}, 30000);\n`);
  const regF = registerStdioSource({ id: "floodside", label: "Flood", command: process.execPath, args: [floodScript] });
  check("flood sidecar registered", regF.ok === true, JSON.stringify(regF));
  await sleep(900);
  const floodState = listSensors().find((s) => s.id === "floodside")?.state;
  check("a flooding sidecar is stopped by the rate cap", floodState === "off" || floodState === "error", floodState);
  unregisterStdioSource("floodside");
  const badStart = registerStdioSource({ id: "nope", label: "nope", command: "definitely-not-a-real-exe-xyz" });
  check("a bad command still registers (state reports the failure, honestly)", badStart.ok === true);
  await sleep(600);
  check("a failed spawn is a stated error state", listSensors().find((s) => s.id === "nope")?.state === "error");
  unregisterStdioSource("nope");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "[ehc] sensor bus tests: ALL PASS" : `[ehc] sensor bus tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] sensor bus tests crashed:", e); process.exit(1); });
