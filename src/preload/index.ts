// Event Horizon Code — Preload (thin, contextIsolation-friendly)
// Exposes minimal window.eventhorizon API. No Node in renderer.
// Runtime credentials pass over IPC only — never in URL/DOM.

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("eventhorizon", {
  version: "0.1.0",
  getRuntime: () => ipcRenderer.invoke("runtime:info") as Promise<{ baseUrl: string; password: string; port: number } | null>,
});
