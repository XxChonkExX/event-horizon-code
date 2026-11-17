// Event Horizon Code — Preload (thin, contextIsolation-friendly)
// Exposes minimal window.eventhorizon API. No Node in renderer.
// Runtime credentials pass over IPC only — never in URL/DOM.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("eventhorizon", {
  version: "0.1.0",
  getRuntime: () => ipcRenderer.invoke("runtime:info") as Promise<{ baseUrl: string; port: number } | null>,
  pickFolder: () => ipcRenderer.invoke("dialog:pickFolder") as Promise<string | null>,
  popoutWindow: (kind: string, sessionId: string, worktree?: string) => ipcRenderer.invoke("window:popout", kind, sessionId, worktree) as Promise<number>,
  growWindow: (targetWidth: number) => ipcRenderer.invoke("window:grow", targetWidth) as Promise<boolean>,
  nudgeWindow: () => ipcRenderer.invoke("window:nudge") as Promise<boolean>,
  editAction: (action: string) => ipcRenderer.invoke("edit:action", action) as Promise<boolean>,
  apiProxy: (req: { method?: string; path?: string; body?: unknown }) => ipcRenderer.invoke("api:proxy", req) as Promise<{ status: number; body: unknown }>,
  eventTicket: () => ipcRenderer.invoke("events:ticket") as Promise<string>,
  fsOp: (op: { kind: string; path: string; to?: string; type?: string }, root?: string) => ipcRenderer.invoke("fs:op", op, root) as Promise<{ ok: boolean; error?: string }>,
});
