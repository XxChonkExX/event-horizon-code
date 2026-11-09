// Event Horizon Code — Preload (thin, contextIsolation-friendly)
// Exposes minimal window.eventhorizon API. No Node in renderer.

import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("eventhorizon", {
  version: "0.1.0"
});
