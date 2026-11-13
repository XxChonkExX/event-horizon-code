// Event Horizon Code — Renderer server client
// Gets runtime credentials over the preload bridge (IPC), never from DOM/URL.
// All server calls carry Basic auth. connect-src CSP already allows 127.0.0.1:*.

type RuntimeInfo = { baseUrl: string; password: string; port: number } | null;

declare global {
  interface Window {
    eventhorizon?: {
      version: string;
      getRuntime: () => Promise<RuntimeInfo>;
      pickFolder: () => Promise<string | null>;
      popoutWindow: (kind: string, sessionId: string) => Promise<number>;
      growWindow: (targetWidth: number) => Promise<boolean>;
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

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const rt = await runtimeInfo();
  if (!rt) throw new Error("runtime unavailable — renderer not launched from Electron main");
  const headers = new Headers(init?.headers);
  headers.set("Authorization", "Basic " + btoa(`eventhorizon:${rt.password}`));
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${rt.baseUrl}${path}`, { ...init, headers });
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  return (await res.json()) as T;
}

export async function authQuery(): Promise<string> {
  const rt = await runtimeInfo();
  return rt ? `auth=${encodeURIComponent(rt.password)}` : "";
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

export async function popoutWindow(kind: string, sessionId: string): Promise<void> {
  if (typeof window !== "undefined" && window.eventhorizon?.popoutWindow) {
    await window.eventhorizon.popoutWindow(kind, sessionId);
  }
}

// Grow the OS window (never shrink) when content needs room — clamped to work area.
export async function growWindow(targetWidth: number): Promise<void> {
  if (typeof window !== "undefined" && window.eventhorizon?.growWindow) {
    await window.eventhorizon.growWindow(targetWidth);
  }
}
