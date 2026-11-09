// Event Horizon Code — SSE broker
// Replaces LSP diagnostics stub. One stream per worktree subscription.

import type http from "node:http";

type Channel = Set<http.ServerResponse>;

const channels = new Map<string, Channel>();

export function subscribe(worktree: string, res: http.ServerResponse) {
  if (!channels.has(worktree)) channels.set(worktree, new Set());
  channels.get(worktree)!.add(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write("data: {\"type\":\"connected\"}\n\n");
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 25000);
  res.on("close", () => {
    clearInterval(ping);
    channels.get(worktree)?.delete(res);
    if (channels.get(worktree)?.size === 0) channels.delete(worktree);
  });
}

export function broadcast(worktree: string, type: string, payload: unknown) {
  const set = channels.get(worktree);
  if (!set) return;
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(msg); } catch { /* ignore */ }
  }
}
