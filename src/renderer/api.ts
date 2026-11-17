// Event Horizon Code — Renderer server client
// Sweep-5 P0: the renderer NEVER holds the API password. Authenticated calls
// go through the main-process proxy (api:proxy); EventSource streams use
// single-use tickets minted in main (events:ticket). The renderer only knows
// the runtime's base URL - never a credential.

type RuntimeInfo = { baseUrl: string; port: number } | null;

declare global {
  interface Window {
    eventhorizon?: {
      version: string;
      getRuntime: () => Promise<RuntimeInfo>;
      pickFolder: () => Promise<string | null>;
      popoutWindow: (kind: string, sessionId: string, worktree?: string) => Promise<number>;
      growWindow: (targetWidth: number) => Promise<boolean>;
      nudgeWindow: () => Promise<boolean>;
      editAction: (action: string) => Promise<boolean>;
      apiProxy: (req: { method?: string; path?: string; body?: unknown }) => Promise<{ status: number; body: unknown }>;
      eventTicket: () => Promise<string>;
      fsOp: (op: { kind: string; path: string; to?: string; type?: string }, root?: string) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}

let cached: RuntimeInfo = null;

export async function runtimeInfo(): Promise<RuntimeInfo> {
  if (cached) return cached;
  if (typeof window !== "undefined" && window.eventhorizon) {
    cached = await window.eventhorizon.getRuntime();
  }
  return cached;
}

// Proxied fetch: the main process attaches the credential. The Response-like
// shape is preserved so callers keep working.
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== "undefined" && window.eventhorizon?.apiProxy) {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) as unknown : undefined;
    const r = await window.eventhorizon.apiProxy({ method, path, body });
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }
  const rt = await runtimeInfo();
  if (!rt) throw new Error("runtime unavailable - renderer not launched from Electron main");
  return fetch(`${rt.baseUrl}${path}`, init);
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  return (await res.json()) as T;
}

// EH-010 + sweep-5: the ticket is minted in MAIN (credential stays there).
// EventSource URLs carry a scoped single-use ticket, never the password.
export async function eventStreamTicket(): Promise<string> {
  if (typeof window !== "undefined" && window.eventhorizon?.eventTicket) {
    return window.eventhorizon.eventTicket();
  }
  throw new Error("runtime unavailable - renderer not launched from Electron main");
}

export function baseUrl(): string {
  return cached?.baseUrl ?? "";
}

export async function pickFolder(): Promise<string | null> {
  if (typeof window !== "undefined" && window.eventhorizon?.pickFolder) {
    return window.eventhorizon.pickFolder();
  }
  return null;
}

export async function popoutWindow(kind: string, sessionId: string, worktree?: string): Promise<void> {
  if (typeof window !== "undefined" && window.eventhorizon?.popoutWindow) {
    await window.eventhorizon.popoutWindow(kind, sessionId, worktree);
  }
}

// Grow the OS window (never shrink) when content needs room — clamped to work area.
export async function growWindow(targetWidth: number): Promise<void> {
  if (typeof window !== "undefined" && window.eventhorizon?.growWindow) {
    await window.eventhorizon.growWindow(targetWidth);
  }
}

// Force a compositor re-measure (a 1px wider then back, all in one IPC). Used
// after palette open to clear a stale/magnified frame on flaky GPU paths.
export async function nudgeWindow(): Promise<void> {
  if (typeof window !== "undefined" && window.eventhorizon?.nudgeWindow) {
    await window.eventhorizon.nudgeWindow();
  }
}

// Edit commands (copy/cut/paste/selectAll) run in the main process on the
// focused webContents - paste cannot be done from the renderer sandbox.
export async function editAction(action: string): Promise<void> {
  if (typeof window !== "undefined" && window.eventhorizon?.editAction) {
    await window.eventhorizon.editAction(action);
  }
}

// File-system operations behind the FileTree context menu (user-initiated,
// path-guarded in the main process).
export async function fsOp(op: { kind: string; path: string; to?: string; type?: string }, root?: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof window !== "undefined" && window.eventhorizon?.fsOp) {
    return window.eventhorizon.fsOp(op, root);
  }
  return { ok: false, error: "not running inside the app" };
}
