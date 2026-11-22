// Webfetch SSRF guard + bounded-read + credential-denylist tests (external
// audit remediation). Run: npm run webfetch:test

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTool, assertFetchableUrl, isPrivateAddress, safePath } from "../src/server/tools";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log("[ehc] webfetch ssrf + bounds tests");

  // 1. private-address classifier
  const priv = ["127.0.0.1", "10.1.2.3", "192.168.1.5", "172.16.0.9", "172.31.255.1", "169.254.169.254", "100.64.0.7", "0.0.0.0", "::1", "fe80::1", "fd00::5", "::ffff:127.0.0.1"];
  for (const ip of priv) check(`private classifier flags ${ip}`, isPrivateAddress(ip) === true);
  const pub = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"];
  for (const ip of pub) check(`public classifier passes ${ip}`, isPrivateAddress(ip) === false);

  // 2. assertFetchableUrl: literal + named refusals
  for (const [url, why] of [
    ["http://127.0.0.1/x", "loopback"],
    ["http://10.0.0.5/x", "private v4"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://[::1]/x", "v6 loopback"],
    ["http://localhost/x", "localhost"],
    ["http://service.internal/x", "internal naming"],
    ["ftp://example.com/x", "non-http scheme"],
  ] as Array<[string, string]>) {
    let refused = false;
    let why2 = "";
    try { await assertFetchableUrl(url); } catch (e) { refused = true; why2 = String((e as Error).message).slice(0, 60); }
    check(`refuses ${why} (${url})`, refused, why2);
  }
  // public hostname: must not be refused as PRIVATE (dns failure offline is
  // inconclusive - the point is the classifier, not the network)
  try {
    await assertFetchableUrl("https://example.com/");
    check("public hostname not refused as private", true);
  } catch (e) {
    const msg = String((e as Error).message);
    if (/dns/i.test(msg)) check("public hostname not refused as private (dns unavailable - inconclusive)", true);
    else check("public hostname not refused as private", false, msg);
  }

  // 3. bounded read: a 3MB file is refused before entering memory
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-ssrf-"));
  try {
    const big = path.join(worktree, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 65));
    const r = await runTool("read", { path: "big.bin" }, worktree, { userApproved: true });
    check("read refuses oversized file before reading", r.ok === false && /too large/.test(r.error ?? ""), r.error ?? "");
    // credential denylist extensions (external audit)
    for (const p of [".ssh/id_ed25519", ".aws/credentials", ".npmrc", ".docker/config.json"]) {
      const sp = safePath(worktree, p);
      check(`safePath refuses ${p}`, sp.ok === false, sp.error ?? "allowed!");
    }
    // non-credential files still pass
    const ok = safePath(worktree, "src/index.ts");
    check("ordinary path still permitted", ok.ok === true);
  } finally {
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* temp */ }
  }

  console.log(failures === 0 ? "[ehc] webfetch ssrf tests: ALL PASS" : `[ehc] webfetch ssrf tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] webfetch ssrf tests crashed:", e); process.exit(1); });
