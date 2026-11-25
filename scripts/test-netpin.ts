// DNS-pin tests (src/server/dnspin.ts): the shared connection-pinning used by
// webfetch AND the BYOK lane. Proves: resolution behavior (IP literals,
// hostnames, stated failure for unresolvable names), and - end to end - that
// the BYOK lane (chatOpenAI) still works through the pinned dispatcher against
// a plain LAN/loopback endpoint (the llama-server / LM Studio case), and fails
// honestly against a dead one. Run: npm run netpin:test
import http from "node:http";
import { chatOpenAI } from "../src/server/router";
import { resolveHostAddrs, pinnedAgent } from "../src/server/dnspin";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log("[ehc] dns-pin tests");

  // 1. resolution: IP literals pass through, hostnames resolve, failures state themselves
  check("IPv4 literal passes through", JSON.stringify(await resolveHostAddrs("127.0.0.1")) === '["127.0.0.1"]');
  const localhost = await resolveHostAddrs("localhost");
  check("localhost resolves to loopback", localhost.includes("127.0.0.1") || localhost.includes("::1"), JSON.stringify(localhost));
  let dnsErr = "";
  try { await resolveHostAddrs("ehc-does-not-exist.invalid"); } catch (e) { dnsErr = String((e as Error).message); }
  check("an unresolvable name states the failure", /did not resolve|no address for/.test(dnsErr), dnsErr);

  // 2. end to end: the BYOK lane through the pin, against a loopback endpoint
  const seen: string[] = [];
  const stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} auth=${(req.headers.authorization ?? "").startsWith("Bearer ")}`);
      const completion = { choices: [{ message: { role: "assistant", content: "pong" } }], usage: { completion_tokens: 1 } };
      if (String(req.url ?? "").endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(completion));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  const port = await new Promise<number>((resolve) => { const s = stub.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port)); });

  const r = await chatOpenAI("stub-model", [{ role: "user", content: "ping" }], {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "test-key-not-real",
    numPredict: 8,
    timeoutMs: 10_000,
  });
  check("chatOpenAI through the pinned dispatcher works on loopback", r.ok === true && r.content === "pong", JSON.stringify({ ok: r.ok, error: r.error }));
  check("the request went to the configured endpoint with a Bearer header", seen.some((s) => s.includes("POST /v1/chat/completions") && s.includes("auth=true")), seen.join(" | "));

  const dead = await chatOpenAI("stub-model", [{ role: "user", content: "ping" }], {
    baseUrl: "http://127.0.0.1:9/v1", // port 1-9: nothing listens there
    apiKey: "k",
    numPredict: 8,
    timeoutMs: 5000,
  });
  check("a dead endpoint fails honestly (never silently)", dead.ok === false && /unreachable/.test(dead.error ?? ""), dead.error);

  stub.close();
  console.log(failures === 0 ? "[ehc] dns-pin tests: ALL PASS" : `[ehc] dns-pin tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] dns-pin tests crashed:", e); process.exit(1); });
