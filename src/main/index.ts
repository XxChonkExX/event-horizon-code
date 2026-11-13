// Event Horizon Code — Electron main process (thin by design)
// Owns: windows, menus, single-instance lock, localhost server bootstrap
// Non-negotiable: no domain logic here. Sessions/tools/engrams live in server.

import { app, BrowserWindow, Menu, ipcMain, dialog, screen } from "electron";
import path from "node:path";
import crypto from "node:crypto";
import { startLocalServer } from "../server/index";

const port = 8800 + Math.floor(Math.random() * 800);
const password = crypto.randomBytes(24).toString("hex");
let runtime: { baseUrl: string; password: string; port: number } | null = null;

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  await startLocalServer({ port, password });
  runtime = { baseUrl: `http://127.0.0.1:${port}`, password, port };
  ipcMain.handle("runtime:info", () => runtime);
  // Folder picker for the Model Manager (renderer has no fs access by design).
  ipcMain.handle("dialog:pickFolder", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const r = await dialog.showOpenDialog(win as BrowserWindow, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  // Pop-out windows: terminal / chat in their own OS window, same session.
  ipcMain.handle("window:popout", (_e, kind: string, sessionId: string) => {
    const win = new BrowserWindow({
      width: 980, height: 720,
      title: `Event Horizon — ${kind}`,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false,
        preload: path.join(__dirname, "../preload/index.js"),
      }
    });
    const query = `popout=${encodeURIComponent(kind)}&session=${encodeURIComponent(sessionId ?? "default")}`;
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) void win.loadURL(`${devUrl}/?${query}`);
    else void win.loadFile(path.join(__dirname, "../renderer/index.html"), { search: query });
    return win.id;
  });
  // Widen the window when content needs room (e.g. editor tabs opened).
  // Grow-only, clamped to the display work area; shifts left if it would overflow.
  ipcMain.handle("window:grow", (e, targetW: number) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    const display = screen.getDisplayNearestPoint(win.getBounds());
    const wa = display.workArea;
    const target = Math.min(Math.round(targetW), wa.width);
    const b = win.getBounds();
    if (b.width >= target) return false;
    let x = b.x;
    if (b.x + target > wa.x + wa.width) x = Math.max(wa.x, wa.x + wa.width - target);
    win.setBounds({ x, y: b.y, width: target, height: b.height });
    return true;
  });
  Menu.setApplicationMenu(null);
  const windows = new Map<string, BrowserWindow>();
  // Multi-window: one BrowserWindow per session/worktree
  function openWindow(sessionId: string) {
    const win = new BrowserWindow({
      width: 1440, height: 900,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false,
        preload: path.join(__dirname, "../preload/index.js"),
      }
    });
    windows.set(sessionId, win);
    // Dev: electron-vite serves the renderer live (HMR). Prod: load the built file.
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
      void win.loadURL(`${devUrl}/?session=${encodeURIComponent(sessionId)}`);
    } else {
      void win.loadFile(path.join(__dirname, "../renderer/index.html"), { query: { session: sessionId } });
    }
  }
  openWindow("default");
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) openWindow("default"); });
});
