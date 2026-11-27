// Event Horizon Code — Preload (thin, contextIsolation-friendly)
// Exposes minimal window.eventhorizon API. No Node in renderer.
// Runtime credentials pass over IPC only — never in URL/DOM.

import { contextBridge, ipcRenderer, webUtils } from "electron";
import { APP_VERSION } from "../shared/version";

contextBridge.exposeInMainWorld("eventhorizon", {
  version: APP_VERSION,
  getRuntime: () => ipcRenderer.invoke("runtime:info") as Promise<{ baseUrl: string; port: number } | null>,
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder") as Promise<string | null>,
  popoutWindow: (kind: string, sessionId: string, worktree?: string, url?: string) => ipcRenderer.invoke("window:popout", kind, sessionId, worktree, url) as Promise<number>,
  growWindow: (targetWidth: number) => ipcRenderer.invoke("window:grow", targetWidth) as Promise<boolean>,
  nudgeWindow: () => ipcRenderer.invoke("window:nudge") as Promise<boolean>,
  editAction: (action: string) => ipcRenderer.invoke("edit:action", action) as Promise<boolean>,
  apiProxy: (req: { method?: string; path?: string; body?: unknown; timeoutMs?: number }) => ipcRenderer.invoke("api:proxy", req) as Promise<{ status: number; body: unknown }>,
  eventTicket: () => ipcRenderer.invoke("events:ticket") as Promise<string>,
  fsOp: (op: { kind: string; path: string; to?: string; type?: string }, root?: string) => ipcRenderer.invoke("fs:op", op, root) as Promise<{ ok: boolean; error?: string }>,
  revealInFolder: (path: string, root?: string) => ipcRenderer.invoke("shell:reveal", path, root) as Promise<{ ok: boolean; error?: string }>,
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url) as Promise<{ ok: boolean; error?: string }>,
  // Local side files opened from outside the workspace ("Open With", a drop,
  // a double-click): read/written by main with credential refusals; the path
  // for a dropped File comes from webUtils in this preload only.
  fileExternal: (op: { kind: "read" | "write"; path: string; content?: string }) => ipcRenderer.invoke("file:external", op) as Promise<{ ok: boolean; error?: string; path?: string; content?: string }>,
  takePendingFile: () => ipcRenderer.invoke("file:takePending") as Promise<string | null>,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onFileOpen: (cb: (p: { path: string }) => void) => {
    ipcRenderer.on("file:openExternal", (_e, p: { path: string }) => cb(p));
  },
  // The browser window's chrome (only that window's page is answered in main):
  // its own height, so main can place the view, navigation commands, and the
  // page state main pushes back.
  browserChrome: (msg: { kind: "bounds"; height: number }) => { ipcRenderer.send("browser:chrome", msg); },
  browserCmd: (cmd: { op: "navigate" | "back" | "forward" | "reload" | "stop" | "state"; url?: string }) => ipcRenderer.invoke("browser:cmd", cmd) as Promise<{ ok: boolean; error?: string; state?: unknown }>,
  onBrowserState: (cb: (s: unknown) => void) => { ipcRenderer.on("browser:state", (_e, s) => cb(s)); },
  onContextMenu: (cb: (p: { x: number; y: number }) => void) => {
    ipcRenderer.on("context:menu", (_e, p: { x: number; y: number }) => cb(p));
  },
});
