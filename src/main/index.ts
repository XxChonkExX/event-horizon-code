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

// GPU compositing evicts frames from Chromium's compositor while the training
// workload depletes the primary GPU's VRAM. When it evicts EHC's frames, the
// window keeps its title bar but shows a stale/offset frame forever (the whole
// "splayed everywhere, recover on click" bug class). EHC has no visual effect
// that needs hardware compositing - prefer CPU rasterization and lose nothing.
app.commandLine.appendSwitch("disable-gpu-compositing");

// Shared hardening for every window we open. The compositor has died on this
// machine while a training workload was grabbing the GPU; when it does, the
// window holds a ruined frame and is unresponsive. A reload costs a second,
// a dead window costs a session.
function hardenWindow(win: BrowserWindow, label: string): void {
  // Renderer process crash/exit -> reload the window instead of leaving it dead.
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[ehc] ${label} renderer gone (reason=${details.reason}, code=${details.exitCode}) - reloading window`);
    try { win.webContents.reload(); } catch { /* window may be gone too */ }
  });
}

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
  ipcMain.handle("window:popout", (_e, kind: string, sessionId: string) => {    const win = new BrowserWindow({
      width: 980, height: 720,
      title: `Event Horizon — ${kind}`,
      show: false,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
        preload: path.join(__dirname, "../preload/index.js"),
      }
    });
    const query = `popout=${encodeURIComponent(kind)}&session=${encodeURIComponent(sessionId ?? "default")}`;
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) void win.loadURL(`${devUrl}/?${query}`);
    else void win.loadFile(path.join(__dirname, "../renderer/index.html"), { search: query });
    hardenWindow(win, `popout-${kind}`);
    win.once("ready-to-show", () => win.show());
    return win.id;
  });
  // Re-measure nudge: a 1px resize + back. Used to force Chromium/DWM to re-present a
  // stale frame (e.g. after the palette marks a focus transition that wedges the compositor).
  ipcMain.handle("window:nudge", (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win) return false;
    const b = win.getBounds();
    if (b.width < 100) return false;
    win.setBounds({ x: b.x, y: b.y, width: b.width + 1, height: b.height });
    win.setBounds(b);
    return true;
  });
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
  // Multi-window: one BrowserWindow per session/worktree.
  // Clamp to the work area: at high DPI scaling the logical desktop can be
  // smaller than 1440x900, and an oversized window opens with panels off-screen.
  const wa = screen.getPrimaryDisplay().workArea;
  function openWindow(sessionId: string) {
    const win = new BrowserWindow({
      width: Math.min(1440, wa.width),
      height: Math.min(900, wa.height),
      show: false,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
        preload: path.join(__dirname, "../preload/index.js"),
      }
    });
    hardenWindow(win, `window-${sessionId}`);
    windows.set(sessionId, win);
    // Dev: electron-vite serves the renderer live (HMR). Prod: load the built file.
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) {
      void win.loadURL(`${devUrl}/?session=${encodeURIComponent(sessionId)}`);
    } else {
      void win.loadFile(path.join(__dirname, "../renderer/index.html"), { query: { session: sessionId } });
    }
    win.once("ready-to-show", () => win.show());
  }
  openWindow("default");
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) openWindow("default"); });
});
