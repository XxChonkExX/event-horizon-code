// Event Horizon Code - browser window policy (S4). Pure functions, shared by
// the Electron main process (the browser session's guards) and the tests.
//
// docs/BROWSER.md: only http:/https: may load; loopback and private ranges are
// never reached by a page (the local runtime, Ollama, a LAN llama-server);
// no non-canonical numeric hosts. The URL parser canonicalises odd IPv4 forms
// (decimal, octal, hex) before these functions see the host; a hostname that
// RESOLVES into a private range is caught by the async DNS check in main.

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "home.arpa", "broadcasthost"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".home", ".corp", ".private", ".intranet", ".test", ".example", ".invalid"];

// First hop of every non-routable / special-purpose IPv4 block.
const V4_RESERVED: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
  [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0a80000, 16], [0xc6120000, 15],
  [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

export function isPrivateOrLocalHost(hostRaw: string): boolean {
  const host = hostRaw.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (LOCAL_NAMES.has(host) || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateV4(host);
  if (host.includes(":")) return isPrivateV6(host);
  return false;
}

function isPrivateV4(host: string): boolean {
  const p = host.split(".").map((x) => Number(x));
  if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed: refuse
  const n = ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
  return V4_RESERVED.some(([net, bits]) => {
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (net & mask);
  });
}

/** Expands an IPv6 literal (WHATWG-normalised hex groups, `::` and an optional embedded IPv4) to eight 16-bit groups. */
export function parseIpv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const v4tail = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  let v4groups: number[] = [];
  if (v4tail) {
    const p = v4tail[1]!.split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    v4groups = [(p[0]! << 8) | p[1]!, (p[2]! << 8) | p[3]!];
    s = s.slice(0, v4tail.index + (v4tail[0]!.startsWith(":") ? 1 : 0));
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter(Boolean).map((g) => parseInt(g, 16)) : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":").filter(Boolean).map((g) => parseInt(g, 16)) : []) : [];
  if ([...head, ...tail].some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  const total = head.length + tail.length + v4groups.length + (halves.length === 2 ? 1 : 0);
  if (total > 8 || (halves.length === 1 && total !== 8)) return null;
  const fill = 8 - head.length - tail.length - v4groups.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill(0), ...tail, ...v4groups];
}

function isPrivateV6(host: string): boolean {
  const g = parseIpv6(host);
  if (!g) return true; // unparseable literal: refuse
  if (g.every((x) => x === 0)) return true;                 // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0]! & 0xfe00) === 0xfc00) return true;             // fc00::/7 unique-local
  if ((g[0]! & 0xffc0) === 0xfe80) return true;             // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true;             // fec0::/10 site-local (deprecated, still local)
  if ((g[0]! & 0xff00) === 0xff00) return true;             // ff00::/8 multicast
  const v4 = (a: number, b: number): boolean => isPrivateV4(`${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6]!, g[7]!);  // ::ffff:a.b.c.d (v4-mapped)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4(g[6]!, g[7]!); // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);            // 2002::/16 6to4
  return false;
}

export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** A page-level navigation: only http(s), never loopback/private, never a credential-less empty host. */
export function navigationAllowed(input: string): UrlVerdict {
  let url: URL;
  try { url = new URL(input); } catch { return { ok: false, reason: "not a URL" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `scheme ${url.protocol.replace(":", "")} is not allowed - only http and https` };
  if (url.username || url.password) return { ok: false, reason: "URLs with embedded credentials are not allowed - type them into the page" };
  const host = url.hostname;
  if (!host) return { ok: false, reason: "no host" };
  if (isPrivateOrLocalHost(host)) return { ok: false, reason: `${host} is loopback, private or local - the browser never reaches this machine or the LAN` };
  return { ok: true, url };
}

/** A subresource request (seen by onBeforeRequest, http/https only). */
export function requestAllowed(input: string): UrlVerdict {
  let url: URL;
  try { url = new URL(input); } catch { return { ok: false, reason: "not a URL" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: `scheme ${url.protocol.replace(":", "")} is not allowed` };
  if (isPrivateOrLocalHost(url.hostname)) return { ok: false, reason: `${url.hostname} is loopback, private or local` };
  return { ok: true, url };
}

/**
 * DNS rebinding defence: a public-looking hostname whose records point into
 * loopback or a private range. `resolve` is injected so the policy stays pure;
 * an unresolvable host is left to fail on its own.
 */
export async function hostResolvesPrivate(host: string, resolve: (host: string) => Promise<string[]>): Promise<string | null> {
  if (isIpLiteral(host.replace(/^\[|\]$/g, ""))) return null;
  let addrs: string[];
  try { addrs = await resolve(host); } catch { return null; }
  const hit = addrs.find((a) => isPrivateOrLocalHost(a));
  return hit ? `${host} resolves to ${hit}` : null;
}
