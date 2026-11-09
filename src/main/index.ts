// Event Horizon Code — Electron main process (thin by design)
// Owns: windows, menus, single-instance lock, localhost server bootstrap
// Non-negotiable: no domain logic here. Sessions/tools/engrams live in server.

import { app, BrowserWindow, Menu } from "electron";
import crypto from "node:crypto";
import { startLocalServer } from "../server/index";

const port = 8800 + Math.floor(Math.random() * 800);
const password = crypto.randomBytes(24).toString("hex");

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  await startLocalServer({ port, password });
  Menu.setApplicationMenu(null);
  const windows = new Map<string, BrowserWindow>();
  // Multi-window: one BrowserWindow per session/worktree
  function openWindow(sessionId: string) {
    const win = new BrowserWindow({
      width: 1440, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    windows.set(sessionId, win);
    void win.loadFile("out/renderer/index.html", { query: { session: sessionId } });
  }
  openWindow("default");
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) openWindow("default"); });
});
