// Browser policy tests (S4) - fully offline. The pure policy the browser
// session's guards reduce to: only http/https may load; loopback, private and
// local hosts are never reached - by canonical or non-canonical numeric form,
// by name, or by a hostname that resolves there (rebinding).
// Run: npm run browserpolicy:test

import { navigationAllowed, requestAllowed, isPrivateOrLocalHost, hostResolvesPrivate, parseIpv6 } from "../src/shared/browserPolicy";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
const refused = (u: string): string => { const v = navigationAllowed(u); return v.ok ? "" : v.reason; };
const allowed = (u: string): boolean => navigationAllowed(u).ok;

async function main(): Promise<void> {
  console.log("[ehc] browser policy tests");
// 1. Scheme policy: only http and https.
for (const u of ["file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,<h1>x</h1>", "about:blank", "chrome://settings", "view-source:https://example.com", "ftp://example.com/", "blob:https://example.com/abc", "wss://example.com/socket", "ms-settings:windowsupdate", "file://server/share/doc"]) {
  check(`scheme refused: ${u.slice(0, 44)}`, !allowed(u), refused(u));
}
check("https is allowed", allowed("https://example.com/path?q=1#frag"));
check("http is allowed (marked not secure by the chrome)", allowed("http://example.com/"));
check("a port is fine", allowed("https://example.com:8443/"));
check("embedded credentials are refused", !allowed("https://user:pass@example.com/"), refused("https://user:pass@example.com/"));
check("not a URL is refused", !allowed("not a url"));
check("an empty host is refused", !allowed("http://"));

// 2. Loopback / private / local by canonical name and address.
const priv = [
  "http://localhost/", "http://LOCALHOST./", "http://app.localhost/", "http://printer.local/", "http://db.internal/", "http://nas.lan/", "http://wiki.corp/", "http://x.home.arpa/",
  "http://127.0.0.1/", "http://127.8.8.8:4126/", "http://10.0.0.5/", "http://172.16.0.9/", "http://172.31.255.1/", "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/", "http://100.64.0.7/", "http://0.0.0.0/", "http://198.18.0.5/", "http://198.51.100.9/", "http://203.0.113.7/", "http://192.0.2.4/", "http://224.0.0.1/", "http://240.1.2.3/",
  "http://[::1]/", "http://[::]/", "http://[fe80::1]/", "http://[fd00::5]/", "http://[fc00::1]/", "http://[ff02::1]/", "http://[fec0::1]/",
  "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:192.168.1.5]/", "http://[64:ff9b::7f00:1]/", "http://[2002:7f00:1::]/",
];
for (const u of priv) check(`private/local refused: ${u.slice(7, 40)}`, !allowed(u), refused(u));

// 3. Non-canonical numeric hosts - the URL parser canonicalises them, and the policy sees the real address.
check("decimal loopback refused (2130706433)", !allowed("http://2130706433/"), refused("http://2130706433/"));
check("octal loopback refused (0177.0.0.1)", !allowed("http://0177.0.0.1/"), refused("http://0177.0.0.1/"));
check("hex loopback refused (0x7f.1)", !allowed("http://0x7f.1/"), refused("http://0x7f.1/"));
check("hex private refused (0xc0a80101)", !allowed("http://0xc0a80101/"), refused("http://0xc0a80101/"));
check("short private refused (10.1)", !allowed("http://10.1/"), refused("http://10.1/"));
check("short loopback refused (127.1)", !allowed("http://127.1/"), refused("http://127.1/"));
check("decimal private refused (3232235777 = 192.168.1.1)", !allowed("http://3232235777/"), refused("http://3232235777/"));

// 4. Public addresses and names pass.
const pub = ["http://8.8.8.8/", "http://1.1.1.1/", "http://93.184.216.34/", "http://[2606:4700:4700::1111]/", "http://[2001:db8::1]/", "https://example.com/", "https://api.github.com/x", "https://sub.domain.example.co.uk/", "https://en.wikipedia.org/wiki/URL"];
for (const u of pub) check(`public allowed: ${u.slice(0, 44)}`, allowed(u), refused(u));

// 5. Subresource policy (what onBeforeRequest sees).
check("subresource to a public host is allowed", requestAllowed("https://cdn.example.com/app.js").ok);
check("subresource to loopback is cancelled", !requestAllowed("http://127.0.0.1:11434/api/tags").ok);
check("subresource to a private host is cancelled", !requestAllowed("http://192.168.1.20:8080/x").ok);
check("subresource to a .local name is cancelled", !requestAllowed("http://ollama.local:11434/").ok);
check("subresource to the runtime port is cancelled", !requestAllowed("http://localhost:4126/global/health").ok);

// 6. The predicate behind everything.
check("isPrivateOrLocalHost: localhost", isPrivateOrLocalHost("localhost") && isPrivateOrLocalHost("LocalHost"));
check("isPrivateOrLocalHost: public names are not", !isPrivateOrLocalHost("example.com") && !isPrivateOrLocalHost("github.com"));
check("isPrivateOrLocalHost: a public IPv6 is not", !isPrivateOrLocalHost("[2606:4700:4700::1111]"));
check("isPrivateOrLocalHost: a malformed IPv4 is refused", isPrivateOrLocalHost("999.1.1.1"));
check("isPrivateOrLocalHost: an unparseable IPv6 literal is refused", isPrivateOrLocalHost("[:::1:::]"));

// 7. IPv6 expansion (the parser the predicate depends on).
check("parseIpv6: :: expands to eight zero groups", JSON.stringify(parseIpv6("::")) === JSON.stringify([0, 0, 0, 0, 0, 0, 0, 0]));
check("parseIpv6: ::1", parseIpv6("::1")?.[7] === 1);
check("parseIpv6: a v4-mapped tail becomes two groups", JSON.stringify(parseIpv6("::ffff:127.0.0.1")) === JSON.stringify([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x1]));
check("parseIpv6: too many groups is null", parseIpv6("1:2:3:4:5:6:7:8:9") === null);
check("parseIpv6: two :: are null", parseIpv6("1::2::3") === null);
check("parseIpv6: a full address without ::", parseIpv6("2001:db8::1")?.[0] === 0x2001);

// 8. DNS rebinding: a public-looking name whose records point inward.
const resolves = async (host: string, addrs: string[]): Promise<string | null> => hostResolvesPrivate(host, async () => addrs);
check("a name resolving to loopback is caught", (await resolves("evil.example", ["127.0.0.1"])) !== null);
check("a name resolving to a private range is caught", (await resolves("evil.example", ["10.1.2.3"])) !== null);
check("a name with one private and one public record is caught", (await resolves("evil.example", ["93.184.216.34", "192.168.1.1"])) !== null);
check("a name resolving only publicly passes", (await resolves("ok.example", ["93.184.216.34", "2606:4700::1"])) === null);
check("an IP literal is not looked up (already classified)", (await resolves("8.8.8.8", ["127.0.0.1"])) === null);
check("an unresolvable name is left to fail on its own", (await resolves("nx.example", Promise.reject(new Error("ENOTFOUND")) as never)) === null);

  console.log(failures === 0 ? "[ehc] browser policy tests: ALL PASS" : `[ehc] browser policy tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);

}

main().catch((e) => { console.error("[ehc] browser policy tests crashed:", e); process.exit(1); });
