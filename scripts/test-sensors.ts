// Camera sensor tests (sensors S3) - fully offline. A loopback stub stands in
// for a BYOK provider so the consent gate and the request shape can be checked
// with no real network and no real key.
// Run: npm run sensors:test

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { cameraLanes, frameFromDataUrl, look } from "../src/server/sensors";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function main(): Promise<void> {
  console.log("[ehc] camera sensor tests");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-sensors-"));
  process.env.EH_AUDIT_LOG = path.join(tmp, "audit.jsonl");

  // A BYOK provider that is really a loopback stub recording every request.
  const hits: Array<{ url: string; auth: string | undefined; body: string }> = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      hits.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "stub", choices: [{ message: { role: "assistant", content: "A cyan 42 on black." } }], usage: { completion_tokens: 5 } }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  const secretsFile = path.join(tmp, "secrets.json");
  fs.writeFileSync(secretsFile, JSON.stringify({ stub: { baseUrl: `${base}/v1`, apiKey: "test-key-123", model: "vision-stub" } }));
  process.env.EH_SECRETS_FILE = secretsFile;

  // 1. What counts as a frame.
  const jpeg = `data:image/jpeg;base64,${PNG_1x1}`;
  check("a JPEG data URL is a frame", frameFromDataUrl(jpeg)?.mime === "image/jpeg");
  check("PNG and WebP are frames too", frameFromDataUrl(`data:image/png;base64,${PNG_1x1}`)?.mime === "image/png" && frameFromDataUrl("data:image/webp;base64,AAAA")?.mime === "image/webp");
  check("SVG is refused (it can carry script)", frameFromDataUrl("data:image/svg+xml;base64,PHN2Zy8+") === null);
  check("a remote URL is refused - only the frame itself may be sent", frameFromDataUrl("https://evil.test/cam.jpg") === null);
  check("an oversize frame is refused (3 MiB of base64 is 2.25 MiB decoded)", frameFromDataUrl(`data:image/jpeg;base64,${"A".repeat(3 * 1024 * 1024)}`) === null);
  check("a frame just under the cap is accepted", frameFromDataUrl(`data:image/jpeg;base64,${"A".repeat(2 * 1024 * 1024)}`)?.bytes === 1572864);
  check("garbage is refused", frameFromDataUrl("not a data url") === null && frameFromDataUrl("data:image/jpeg;base64,") === null);

  // 2. Lanes list endpoints and models - never a key.
  const lanes = cameraLanes();
  check("the BYOK lane lists the saved provider with its endpoint and model", lanes.byok.some((p) => p.provider === "stub" && p.baseUrl === `${base}/v1` && p.model === "vision-stub"), JSON.stringify(lanes.byok));
  check("the lane list never carries the key", !JSON.stringify(lanes).includes("test-key-123"));
  check("the engine lane is absent while no engine runs", lanes.engine === null);

  // 3. The engine lane says so when the engine is off.
  const engineOff = await look({ image: jpeg, question: "what is this?", lane: "engine" });
  check("engine lane refuses plainly when the engine is not running", engineOff.ok === false && /not running/.test(engineOff.error ?? ""), engineOff.error ?? "");

  // 4. The consent gate.
  const q = "Read the number.";
  const no = await look({ image: jpeg, question: q, lane: "byok", provider: "stub" });
  check("BYOK without consent is refused and asks for it", no.ok === false && no.needsConsent === true && /leaves this computer/.test(no.error ?? ""), no.error ?? "");
  check("a refused look makes no request", hits.length === 0);
  const sloppy = await look({ image: jpeg, question: q, lane: "byok", provider: "stub", allowRemote: "true" as unknown as boolean });
  check("consent must be a real yes (a string does not count)", sloppy.needsConsent === true && hits.length === 0);
  const unknown = await look({ image: jpeg, question: q, lane: "byok", provider: "not-saved", allowRemote: true });
  check("an unsaved provider is refused before any request", unknown.ok === false && /no key or endpoint/.test(unknown.error ?? "") && hits.length === 0, unknown.error ?? "");
  const bad = await look({ image: "data:image/svg+xml;base64,PHN2Zy8+", question: q, lane: "byok", provider: "stub", allowRemote: true });
  check("a non-frame is refused even with consent", bad.ok === false && /frame/.test(bad.error ?? "") && hits.length === 0);

  // 5. With consent: exactly one request, to the stub, with the key and the frame.
  const yes = await look({ image: jpeg, question: q, lane: "byok", provider: "stub", allowRemote: true });
  check("BYOK with consent answers", yes.ok === true && yes.text === "A cyan 42 on black.", JSON.stringify(yes));
  check("exactly one request was made, to /v1/chat/completions", hits.length === 1 && hits[0]!.url === "/v1/chat/completions", hits.map((h) => h.url).join(","));
  check("the provider's key went only in the Authorization header", hits[0]!.auth === "Bearer test-key-123" && !hits[0]!.body.includes("test-key-123"));
  check("the request carries the question and the frame as an image part", hits[0]!.body.includes(q) && hits[0]!.body.includes("image_url") && hits[0]!.body.includes(PNG_1x1.slice(0, 40)));
  const sent = JSON.parse(hits[0]!.body) as { messages: Array<{ role: string; images?: unknown[] }>; model: string };
  check("nothing but text and the image is sent - no local paths, no device names", !/C:\\|\/home\/|\/Users\//.test(hits[0]!.body) && sent.model === "vision-stub" && Array.isArray(sent.messages));
  const audit = fs.readFileSync(process.env.EH_AUDIT_LOG, "utf8");
  // Audited looks: the two refusals and the one sent. (The unsaved-provider and
  // non-frame cases return before the audit line by design.)
  const auditCount = (audit.match(/"tool":\s*"camera\.look"/g) ?? []).length;
  check("each look is audited by lane and size, without the frame or the key", auditCount === 3 && (audit.match(/REFUSED/g) ?? []).length === 2 && audit.includes("127.0.0.1") && !audit.includes(PNG_1x1.slice(0, 20)) && !audit.includes("test-key-123"), `entries=${auditCount} | ${audit.slice(0, 300)}`);

  stub.closeAllConnections();
  await new Promise<void>((r) => stub.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? "[ehc] camera sensor tests: ALL PASS" : `[ehc] camera sensor tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] camera sensor tests crashed:", e); process.exit(1); });
