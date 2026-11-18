// Event Horizon Code — Electron main process (thin by design)
// Owns: windows, menus, single-instance lock, localhost server bootstrap
// Non-negotiable: no domain logic here. Sessions/tools/engrams live in server.

import { app, BrowserWindow, Menu, ipcMain, dialog, screen } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { startLocalServer } from "../server/index";
import { contained } from "../server/wsguard";

type Runtime = { baseUrl: string; password: string; port: number };
let runtime: Runtime | null = null;

// Attach-first: if a runtime is already serving (headless `npm run serve`, or
// a descriptor left by a previous window), reuse it instead of forking a
// second server on a random port. Two servers on one SQLite file made "works
// via curl, not in the app" a recurring mystery.
async function resolveRuntime(): Promise<Runtime> {
  const descriptorPath = path.join(os.homedir(), ".eventhorizon", "runtime.json");
  try {
    const d = JSON.parse(fs.readFileSync(descriptorPath, "utf8")) as { port?: number; password?: string; pid?: number };
    // EH-005: a descriptor whose owning process is dead is stale - never attach.
    const pidAlive = typeof d.pid === "number" && (() => { try { process.kill(d.pid as number, 0); return true; } catch { return false; } })();
    if (pidAlive && typeof d.port === "number" && typeof d.password === "string") {
      const r = await fetch(`http://127.0.0.1:${d.port}/global/health`, {
        headers: { authorization: "Basic " + Buffer.from(`eventhorizon:${d.password}`).toString("base64") },
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) {
        console.log(`[ehc] attaching to existing runtime on port ${d.port} (pid ${d.pid})`);
        return { baseUrl: `http://127.0.0.1:${d.port}`, password: d.password, port: d.port };
      }
    }
  } catch { /* stale or missing descriptor: spawn our own */ }

  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 8800 + Math.floor(Math.random() * 800);
    const password = crypto.randomBytes(24).toString("hex");
    try {
      await startLocalServer({ port, password });
      console.log(`[ehc] spawned embedded runtime on port ${port}`);
      return { baseUrl: `http://127.0.0.1:${port}`, password, port };
    } catch (e) {
      console.error(`[ehc] runtime spawn failed on port ${port} (attempt ${attempt + 1})`, e);
    }
  }
  throw new Error("[ehc] could not start or attach to a local runtime");
}

// GPU compositing evicts frames from Chromium's compositor while the training
// workload depletes the primary GPU's VRAM. When it evicts EHC's frames, the
// window keeps its title bar but shows a stale/offset frame forever (the whole
// "splayed everywhere, recover on click" bug class). EHC has no visual effect
// that needs hardware compositing - prefer CPU rasterization and lose nothing.
app.commandLine.appendSwitch("disable-gpu-compositing");

// Keep background/occluded windows painting: agent replies stream through
// rAF-adjacent DOM writes, and Chromium pauses rAF (and clamps timers) for
// windows that lose focus. `backgroundThrottling: false` on each window covers
// the blurred case; these process-level switches additionally stop Chromium
// from backgrounding or occlusion-throttling the renderer, so a turn that is
// mid-review pauses at its speed, not at a hidden window's. Hermes Desktop
// ships the same three. (Cost: extra CPU while hidden - the right trade for a
// streaming agent.)
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");

// Shared hardening for every window we open. The compositor has died on this
// machine while a training workload was grabbing the GPU; when it does, the
// window holds a ruined frame and is unresponsive. A reload costs a second,
// a dead window costs a session.
// The windows must never fall back to Chromium's default white: popups and
// restored windows painted white before the first frame landed (OpenCode's
// white-flash fix, PR #28247). EHC's document-level canvas is #0b0b10.
const WINDOW_BACKGROUND = "#0b0b10";

// Sweep-3 EH: privileged IPC must only ever answer OUR renderer. A compromised
// or future-untrusted frame gets nothing - most importantly not runtime:info,
// which carries the local API password.
function isTrustedRenderer(e: Electron.IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  if (!frame || frame !== e.sender.mainFrame) return false; // reject subframes
  let url: URL;
  try { url = new URL(frame.url); } catch { return false; }
  if (url.protocol === "file:") {
    // Packaged build: the frame must be our own bundled index.html.
    try {
      const actual = path.resolve(fileURLToPath(url));
      const expected = path.resolve(path.join(__dirname, "../renderer/index.html"));
      return process.platform === "win32"
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual === expected;
    } catch { return false; }
  }
  // Development build: only the configured vite origin, root path.
  const configured = process.env.ELECTRON_RENDERER_URL;
  if (!configured) return false;
  try {
    const expected = new URL(configured);
    return url.origin === expected.origin && (url.pathname === "/" || url.pathname === "");
  } catch { return false; }
}

function hardenWindow(win: BrowserWindow, label: string): void {
  // Sweep-3: the renderer must never navigate away from our own content, and
  // it must not open arbitrary popups (window.open is denied - pop-outs go
  // through the explicit window:popout IPC).
  win.webContents.on("will-navigate", (e) => { e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Renderer process crash/exit -> reload the window instead of leaving it dead.
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[ehc] ${label} renderer gone (reason=${details.reason}, code=${details.exitCode}) - reloading window`);
    try { win.webContents.reload(); } catch { /* window may be gone too */ }
  });
  // A missing renderer build (or an unreachable dev server) used to leave a
  // blank window with only a console message. State the cause in the window.
  win.webContents.on("did-fail-load", (_e, errorCode, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 /* ERR_ABORTED */) return;
    console.error(`[ehc] ${label} failed to load ${validatedURL}: ${errorCode} ${description}`);
    const hint = validatedURL.startsWith("file:")
      ? "The renderer build is missing. Run <code>npm run build</code> in the repo and relaunch, or use <code>npm run dev</code> for the live dev server."
      : "The dev renderer could not be reached. Is <code>npm run dev</code> running?";
    const html = `<!doctype html><meta charset="utf-8"><body style="background:#0b0b10;color:#d6d6de;font:14px system-ui,sans-serif;padding:48px"><h1 style="color:#22d3ee">Event Horizon Code</h1><h2>Renderer could not load</h2><p>${hint}</p><pre style="color:#8f8f9c;white-space:pre-wrap">${errorCode} ${description}\n${validatedURL}</pre></body>`;
    try { void win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`); } catch { /* window gone */ }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  runtime = await resolveRuntime();
  ipcMain.handle("runtime:info", (e) => {
    if (!isTrustedRenderer(e)) throw new Error("Untrusted IPC sender");
    // Sweep-5 P0: the renderer never receives the API password. Authenticated
    // calls go through api:proxy (below); EventSource gets scoped tickets.
    return runtime ? { baseUrl: runtime.baseUrl, port: runtime.port } : null;
  });
  // Folder picker for the Model Manager (renderer has no fs access by design).
  ipcMain.handle("dialog:pickFolder", async (e) => {
    if (!isTrustedRenderer(e)) return null;
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const r = await dialog.showOpenDialog(win as BrowserWindow, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  // Pop-out windows: terminal / chat in their own OS window, same session.
  // Sweep-3: kind is allowlisted, and only trusted renderers may spawn windows.
  const POPOUT_KINDS = new Set(["terminal", "chat"]);
  ipcMain.handle("window:popout", (e, kind: string, sessionId: string, worktree?: string) => {
    if (!isTrustedRenderer(e)) return null;
    if (typeof kind !== "string" || !POPOUT_KINDS.has(kind)) return null;
    if (typeof sessionId !== "string" || sessionId.length > 128) return null;
    const win = new BrowserWindow({
      width: 980, height: 720,
      title: `Event Horizon — ${kind}`,
      backgroundColor: WINDOW_BACKGROUND,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false,
        preload: path.join(__dirname, "../preload/index.js"),
      }
    });
    const query = `popout=${encodeURIComponent(kind)}&session=${encodeURIComponent(sessionId ?? "default")}${worktree ? `&wt=${encodeURIComponent(worktree)}` : ""}`;
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
    if (!isTrustedRenderer(e)) return false;
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
    if (!isTrustedRenderer(e)) return false;
    if (typeof targetW !== "number" || !Number.isFinite(targetW)) return false;
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
  // Edit roles are load-bearing: with no application menu, Ctrl+C/V/X and
  // right-click editing never reach Chromium's edit commands on Windows.
  // The menu bar stays invisible; the roles still fire.
  const editMenu = Menu.buildFromTemplate([
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ] },
  ]);
  Menu.setApplicationMenu(editMenu);
  // In-page right-click menu actions (ContextMenu.tsx) run here - paste cannot
  // be done from the renderer sandbox without the clipboard-read permission.
  ipcMain.handle("edit:action", (e, action: string) => {
    if (!isTrustedRenderer(e)) return false;
    if (!["copy", "cut", "paste", "selectAll"].includes(action)) return false; // allowlist (EH-002)
    const wc = BrowserWindow.fromWebContents(e.sender)?.webContents;
    if (!wc) return false;
    if (action === "copy") wc.copy();
    else if (action === "cut") wc.cut();
    else if (action === "paste") wc.paste();
    else if (action === "selectAll") wc.selectAll();
    else return false;
    return true;
  });
  // Sweep-5 P0: authenticated API proxy. The MAIN process owns the credential;
  // the renderer sends (method, path, body) and receives {status, body}.
  // EventSource cannot go through here (it needs a URL), so streams use
  // single-use tickets (events:ticket) - the password never leaves main.
  ipcMain.handle("api:proxy", async (e, req: { method?: string; path?: string; body?: unknown }) => {
    if (!isTrustedRenderer(e)) throw new Error("Untrusted IPC sender");
    if (typeof req?.path !== "string" || !req.path.startsWith("/")) throw new Error("bad path");
    const method = (req.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("bad method");
    const rt = runtime;
    if (!rt) return { status: 503, body: { error: "runtime unavailable" } };
    try {
      const res = await fetch(`${rt.baseUrl}${req.path}`, {
        method,
        headers: {
          authorization: "Basic " + Buffer.from(`eventhorizon:${rt.password}`).toString("base64"),
          ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: AbortSignal.timeout(90_000),
      });
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* non-JSON body passed through */ }
      return { status: res.status, body };
    } catch (err) {
      return { status: 502, body: { error: `proxy failed: ${String((err as Error)?.message ?? err).slice(0, 160)}` } };
    }
  });
  // Single-use event ticket, minted in main (which holds the credential).
  ipcMain.handle("events:ticket", async (e) => {
    if (!isTrustedRenderer(e)) throw new Error("Untrusted IPC sender");
    const rt = runtime;
    if (!rt) throw new Error("runtime unavailable");
    const r = await fetch(`${rt.baseUrl}/api/events/ticket`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(`eventhorizon:${rt.password}`).toString("base64") },
      signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as { ticket?: string; error?: string };
    if (!j.ticket) throw new Error(j.error ?? "ticket unavailable");
    return j.ticket;
  });
  // File-system operations for the FileTree context menu (user-initiated).
  // EH-001/002: canonical containment via the shared guard (sibling-prefix and
  // symlink proof), sender confined to app windows, ops allowlisted, payload
  // shapes and lengths validated at runtime.
  const FS_OPS = new Set(["newFile", "newDir", "rename", "delete"]);
  ipcMain.handle("fs:op", (e, op: { kind?: unknown; path?: unknown; to?: unknown; type?: unknown }, root?: string) => {
    if (!isTrustedRenderer(e)) return { ok: false, error: "rejected sender" };
    // Sweep-back item: operations anchor to the SESSION's validated worktree
    // (passed by the renderer), never the server's cwd - a session pinned to a
    // git worktree cannot touch the host workspace root.
    const rootGuard = contained(process.cwd(), typeof root === "string" && root ? root : ".");
    if (!rootGuard.ok || !rootGuard.abs) return { ok: false, error: rootGuard.error ?? "invalid session worktree" };
    const effectiveRoot = rootGuard.abs;
    if (typeof op?.kind !== "string" || !FS_OPS.has(op.kind)) return { ok: false, error: "unknown op" };
    if (typeof op.path !== "string" || op.path.length === 0 || op.path.length > 1024) return { ok: false, error: "invalid path" };
    if (op.to !== undefined && (typeof op.to !== "string" || op.to.length > 1024)) return { ok: false, error: "invalid destination" };
    const guard = contained(effectiveRoot, op.path);
    if (!guard.ok || !guard.abs) return { ok: false, error: guard.error ?? "path escapes the workspace" };
    const p = guard.abs;
    // Deleting or renaming the workspace root itself is always refused
    // (containment permits "." - the caller decides what the root means).
    if ((op.kind === "delete" || op.kind === "rename") && path.relative(effectiveRoot, p) === "") {
      return { ok: false, error: "the workspace root cannot be deleted or renamed" };
    }
    try {
      if (op.kind === "newFile") {
        if (fs.existsSync(p)) return { ok: false, error: "already exists" };
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "", "utf8");
      } else if (op.kind === "newDir") {
        if (fs.existsSync(p)) return { ok: false, error: "already exists" };
        fs.mkdirSync(p, { recursive: true });
      } else if (op.kind === "rename") {
        if (!fs.existsSync(p)) return { ok: false, error: "not found" };
        const toGuard = contained(process.cwd(), op.to ?? "");
        if (!toGuard.ok || !toGuard.abs) return { ok: false, error: "bad destination" };
        if (fs.existsSync(toGuard.abs)) return { ok: false, error: "destination already exists" };
        fs.renameSync(p, toGuard.abs);
      } else {
        if (!fs.existsSync(p)) return { ok: false, error: "not found" };
        fs.rmSync(p, { recursive: true });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err).slice(0, 160) };
    }
  });
  const windows = new Map<string, BrowserWindow>();
  // Multi-window: one BrowserWindow per session/worktree.
  // Clamp to the work area: at high DPI scaling the logical desktop can be
  // smaller than 1440x900, and an oversized window opens with panels off-screen.
  const wa = screen.getPrimaryDisplay().workArea;
  function openWindow(sessionId: string) {
    const win = new BrowserWindow({
      width: Math.min(1440, wa.width),
      height: Math.min(900, wa.height),
      backgroundColor: WINDOW_BACKGROUND,
      autoHideMenuBar: true,
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
  // The renderer boots against the session id in the ?session= query. Never hand
  // it a made-up id: a window pinned to a non-existent session fails every
  // fork/checkpoint/memory call with "no such session". Ask the local server
  // for the real newest session; create one if the store is empty.
  async function resolveBootSessionId(rt: Runtime): Promise<string> {
    const auth = "Basic " + Buffer.from(`eventhorizon:${rt.password}`).toString("base64");
    try {
      const r = await fetch(`http://127.0.0.1:${rt.port}/api/sessions`, { headers: { authorization: auth } });
      const list = (await r.json()) as Array<{ id: string; lastActivity?: string | null; created?: string }>;
      if (Array.isArray(list) && list.length > 0) {
        return [...list].sort((a, b) => (b.lastActivity ?? b.created ?? "").localeCompare(a.lastActivity ?? a.created ?? ""))[0].id;
      }
      const c = await fetch(`http://127.0.0.1:${rt.port}/api/sessions`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: "{}" });
      const s = (await c.json()) as { id?: string };
      if (s.id) return s.id;
    } catch (e) {
      console.error("[ehc] could not resolve the boot session; falling back to \"default\"", e);
    }
    return "default";
  }
  const bootSession = await resolveBootSessionId(runtime);
  openWindow(bootSession);
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0 && runtime) void resolveBootSessionId(runtime).then(openWindow); });
});
