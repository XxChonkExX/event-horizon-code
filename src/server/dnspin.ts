// Event Horizon Code — DNS pinning (one implementation, multiple users)
//
// webfetch pins connections to VALIDATED addresses: a DNS answer can never be
// swapped for a private one between the check and the connect (DNS rebinding,
// external audit P1). The BYOK lane pins for a different reason: the endpoint
// URL is trusted (the operator configured it), the resolution is not - a
// rebinding resolver must not be able to send the Authorization header
// somewhere else. LAN endpoints (llama-server, LM Studio, vLLM on
// 127.0.0.1/192.168.x) are intentional and supported: BYOK deliberately has
// NO private-range block, because "127.0.0.1" is a documented endpoint.

import dnsPromises from "node:dns/promises";
import { Agent } from "undici";

// Resolve every address (A + AAAA) for a hostname. IP literals (v4 and bare
// v6) pass through unchanged. Throws with a stated reason when the name does
// not resolve - callers turn that into an honest failure.
export async function resolveHostAddrs(hostname: string): Promise<string[]> {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return [hostname];
  const bare = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (bare.includes(":")) return [bare]; // bare IPv6 literal
  let addrs: Array<{ address: string }> = [];
  try {
    addrs = await dnsPromises.lookup(hostname, { all: true });
  } catch (e) {
    // Resolvers differ (some return [], some throw ENOTFOUND): state the
    // failure the same way everywhere.
    throw new Error(`dns: ${hostname} did not resolve (${String((e as Error).message).slice(0, 80)})`);
  }
  if (!addrs.length) throw new Error(`dns: ${hostname} did not resolve (empty answer)`);
  return addrs.map((a) => a.address);
}

// An undici Agent whose lookup returns ONLY the pinned addresses - the socket
// cannot connect elsewhere, whatever DNS says later.
//
// The callback must serve BOTH Node lookup contracts (found empirically on
// Node 26: serving the wrong form is ERR_INVALID_IP_ADDRESS -> "fetch failed"):
//   - the autoSelectFamily path calls with options.all === true and consumes
//     the ARRAY form;
//   - the single path (explicit family) calls with all falsy and consumes
//     (address, family).
export function pinnedAgent(ips: string[]): Agent {
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        const addrs = ips.map((ip) => ({ address: ip, family: ip.includes(":") ? 6 : 4 }));
        if (options && options.all === true) {
          callback(null, addrs);
          return;
        }
        const pick = addrs[Math.floor(Math.random() * addrs.length)]!;
        callback(null, pick.address, pick.family);
      },
    },
  });
}
