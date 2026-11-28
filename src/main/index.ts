// Event Horizon Code — Electron main process (thin by design)
// Owns: windows, menus, single-instance lock, localhost server bootstrap
// Non-negotiable: no domain logic here. Sessions/tools/engrams live in server.

import { app, BrowserWindow, Menu, ipcMain, dialog, screen, shell, session } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { startLocalServer } from "../server/index";
import { contained } from "../server/wsguard";
import { audit } from "../server/audit";
import { allowedExternalUrl } from "../shared/externals";
import { initBrowser, openBrowserWindow } from "./browser";

type Runtime = { baseUrl: string; password: string; port: number };
let runtime: Runtime | null = null;

// Attach-first: if a runtime is already serving (headless `npm run serve`, or
// a descriptor left by a previous window), reuse it instead of forking a
// second server on a random port. Two servers on one SQLite file made "works
// via curl, not in the app" a recurring mystery.
// The workspace the agent operates in. Priority: EH_WORKSPACE env (explicit),
// then a per-user documents folder for packaged installs (never the install
// directory - tools/terminal/LSP paths resolving inside Program Files was the
// packaged-app ENOENT bug). Dev builds keep the repo as the workspace.
function resolveWorkspaceRoot(): string {
  if (process.env.EH_WORKSPACE) {
    fs.mkdirSync(process.env.EH_WORKSPACE, { recursive: true });
    return path.resolve(process.env.EH_WORKSPACE);
  }
  if (app.isPackaged) {
    // Operator's persisted choice wins; first run asks via folder picker.
    const choicePath = path.join(app.getPath("userData"), "workspace.json");
    try {
      const d = JSON.parse(fs.readFileSync(choicePath, "utf8")) as { workspace?: string };
      if (d.workspace && fs.existsSync(d.workspace)) return path.resolve(d.workspace);
    } catch { /* no saved choice yet */ }
    const def = path.join(app.getPath("documents"), "Event Horizon Code");
    fs.mkdirSync(def, { recursive: true });
    const r = dialog.showOpenDialogSync({
      title: "Event Horizon Code - choose your workspace",
      message: "Pick the folder this Event Horizon install should operate in (agent files, worktrees, terminal cwd).",
      defaultPath: def,
      properties: ["openDirectory", "createDirectory"],
    });
    const ws = r?.[0] && fs.existsSync(r[0]) ? path.resolve(r[0]) : def;
    fs.writeFileSync(choicePath, JSON.stringify({ workspace: ws, savedAt: new Date().toISOString() }, null, 2));
    return ws;
  }
  return process.cwd();
}

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

  const workspaceRoot = resolveWorkspaceRoot();
  console.log(`[ehc] workspace root: ${workspaceRoot}`);
  process.chdir(workspaceRoot);
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 8800 + Math.floor(Math.random() * 800);
    const password = crypto.randomBytes(24).toString("hex");
    try {
      await startLocalServer({ port, password, workspaceRoot });
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
const trustedContents = new Set<number>();
const cameraWindows = new Set<number>();

// Sweep-3 EH: privileged IPC must only ever answer OUR renderer. A compromised
// or future-untrusted frame gets nothing - most importantly not runtime:info,
// which carries the local API password.
// Sweep-5 EH: privileged IPC must only ever answer OUR renderer. A compromised
// or future-untrusted frame gets nothing - most importantly not runtime:info,
// which carries the local API password.
function isTrustedRenderer(e: Electron.IpcMainInvokeEvent): boolean {
  const reject = (why: string): boolean => {
    console.error(`[ehc] IPC rejected (${why}) frame=${e.senderFrame?.url ?? "(none)"}`);
    audit({ tool: "ipc.reject", note: `${why} | ${String(e.senderFrame?.url ?? "").slice(0, 160)}` });
    return false;
  };
  const frame = e.senderFrame;
  if (!frame) return reject("no senderFrame");
  if (frame !== e.sender.mainFrame) return reject("subframe");
  let url: URL;
  try { url = new URL(frame.url); } catch { return reject("unparseable frame url"); }
  // Normalize: strip query/hash so a stray search string can never break the
  // path comparison (the in-place switch URL carries ?session=...).
  url.search = "";
  url.hash = "";
  if (url.protocol === "file:") {
    // Packaged build: the frame must be our own bundled index.html.
    try {
      const actual = path.resolve(fileURLToPath(url));
      const expected = path.resolve(path.join(__dirname, "../renderer/index.html"));
      const match = process.platform === "win32"
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual === expected;
      if (!match) return reject(`file path mismatch: ${actual.slice(0, 120)} vs ${expected.slice(0, 120)}`);
      return true;
    } catch (err) { return reject(`file url conversion failed: ${String(err).slice(0, 80)}`); }
  }
  // Development build: only the configured vite origin, root path.
  const configured = process.env.ELECTRON_RENDERER_URL;
  if (!configured) return reject("no ELECTRON_RENDERER_URL in dev");
  try {
    const expected = new URL(configured);
    if (url.origin !== expected.origin) return reject(`origin mismatch: ${url.origin}`);
    if (url.pathname !== "/" && url.pathname !== "") return reject(`pathname mismatch: ${url.pathname}`);
    return true;
  } catch { return reject("bad ELECTRON_RENDERER_URL"); }
}

function hardenWindow(win: BrowserWindow, label: string): void {
  // Only windows built here (main + pop-outs) may ever capture audio; the
  // permission handlers below check membership, not URLs.
  const contentsId = win.webContents.id;
  trustedContents.add(contentsId);
  // The camera window is the only place the camera may ever be opened, and
  // only from when the user opens it until it closes.
  if (label === "popout-camera") cameraWindows.add(contentsId);
  win.webContents.once("destroyed", () => { trustedContents.delete(contentsId); cameraWindows.delete(contentsId); });
  // Right-click relay (context menu refactor): the renderer's DOM contextmenu
  // event proved unreliable in packaged builds - the in-page menu worked in a
  // plain browser (same bundle) but never appeared in the installed app.
  // Electron ALWAYS delivers this main-process event, so forward the exact
  // coordinates and let the renderer re-dispatch a synthetic DOM event at that
  // point, driving the proven in-page menu path (composer, file tree).
  win.webContents.on("context-menu", (_e, props) => {
    try { win.webContents.send("context:menu", { x: props.x, y: props.y }); } catch { /* window gone */ }
  });
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
    // The window is created show:false and shown on ready-to-show - which never
    // fires when the first load fails (no first frame is ever presented). Show
    // the window here or the error page above renders into a window that stays
    // invisible: exactly the "curl works, but there is no app" mystery class.
    try {
      void win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    } catch { /* window gone */ }
  });
  // Electron#48859: on native Wayland, ready-to-show can fail to fire even
  // when the renderer loads fine (upstream Chromium GPU-timing bug,
  // inconsistent; windows stay hidden forever with the process fully alive).
  // The established app-level workaround (FreeTube#8294, chaiNNer#3351) is to
  // reveal on did-finish-load when ready-to-show has not already done it.
  // First-wins via the isVisible guard; failed loads are covered above.
  win.webContents.once("did-finish-load", () => {
    if (process.platform !== "win32" && !win.isDestroyed() && !win.isVisible()) {
      console.warn(`[ehc] ${label}: ready-to-show did not fire (Electron#48859) - revealing on did-finish-load`);
      win.show();
    }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();

// --- Local side files (operator, 2026-11-26): "Open With", drag-drop, argv ---
// The installer registers text/code file associations, and every launch path
// that carries a file lands here. Only an OPERATOR action can put a file on
// argv or into a drop - the model has no channel to either - and the guards
// below mirror the agent tool jail's credential refusals.
const EXTERNAL_BLOCK_EXT = /\.(exe|dll|so|dylib|zip|7z|rar|gz|tgz|tar|msi|msix|appx|bin|iso|img|pdb|jar|class|node|wasm|ttf|otf|woff2?|cab|deb|rpm|dmg|pkg|apk|sqlite|db)$/i;
const EXTERNAL_CREDENTIAL = /(^|[\\/])(\.harness[\\/]secrets\.json|\.eventhorizon[\\/]runtime\.json(\.[^\\/]+)?|\.env(\..+)?|credentials?\.(json|ya?ml)|id_rsa|id_ed25519|id_ecdsa|\.netrc|\.npmrc|\.aws[\\/]credentials|\.docker[\\/]config\.json|\.ssh[\\/][^\\/]+)|\.(pem|key|p12|pfx)$/i;
const EXTERNAL_CAP = 2 * 1024 * 1024; // the editor's own read cap

function guardExternalFile(p: unknown): { ok: true; abs: string } | { ok: false; error: string } {
  if (typeof p !== "string" || p.length === 0 || p.length > 512 || !path.isAbsolute(p)) return { ok: false, error: "an absolute file path is required" };
  const abs = path.resolve(p);
  if (EXTERNAL_CREDENTIAL.test(abs)) return { ok: false, error: "refused: credential files are never opened in the editor" };
  if (EXTERNAL_BLOCK_EXT.test(abs)) return { ok: false, error: "refused: that file type is not opened in a text editor" };
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return { ok: false, error: "file not found" }; }
  if (!st.isFile()) return { ok: false, error: "not a regular file" };
  if (st.size > EXTERNAL_CAP) return { ok: false, error: `file too large for the editor (${(st.size / 1048576).toFixed(1)} MB; cap 2 MB)` };
  return { ok: true, abs };
}

function fileFromArgv(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith("-") || a === ".") continue;
    const g = guardExternalFile(path.resolve(a));
    if (g.ok) return g.abs;
  }
  return null;
}

let pendingExternal: string | null = null;
function deliverExternalFile(p: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send("file:openExternal", { path: p });
  else pendingExternal = p; // no window yet: the renderer collects it on boot
}

app.on("second-instance", (_e, argv) => {
  const f = fileFromArgv(argv);
  if (f) { deliverExternalFile(f); return; }
  const w = BrowserWindow.getAllWindows()[0];
  if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
});
app.on("open-file", (e, p) => { e.preventDefault(); deliverExternalFile(p); });

app.whenReady().then(async () => {
  // Linux: Electron 42 boots happily with no display - the runtime runs, tools
  // work over curl, and no window can ever exist, with zero warnings (found on
  // a Wayland session where a daemon-spawned shell carried no DISPLAY /
  // WAYLAND_DISPLAY). That silent headless zombie breaks the stated-plainly
  // rule: refuse and say how to run headless for real.
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.error("[ehc] no display server found (DISPLAY and WAYLAND_DISPLAY are unset) - the workbench cannot open a window. Launch from inside your graphical session (DISPLAY=:0 or WAYLAND_DISPLAY=wayland-0), or run the headless runtime with `npm run serve`.");
    app.exit(1);
    return;
  }
  // Permissions. Electron grants every request by default; keep that for
  // windows WE opened (clipboard copy/paste, microphone, ...). A webContents
  // that is not one of ours, or a sub-frame, gets nothing - at the check
  // stage as well as the request stage, because most web APIs skip the
  // request when the check already says "granted". Two captures are scoped
  // further: the MICROPHONE to our windows (speech-to-text), and the CAMERA
  // to the camera window alone, from the moment the user opens it until it
  // closes. Denying by default here is a trap: a deny-all handler silently
  // broke clipboard copy and terminal paste in 0.0.3e.
  const ours = (wc: Electron.WebContents | null): boolean => Boolean(wc && trustedContents.has(wc.id));
  const seesCamera = (wc: Electron.WebContents | null): boolean => Boolean(wc && cameraWindows.has(wc.id));
  // Screen capture is refused everywhere, on purpose. Until Electron 45 it
  // arrived as `media` with no types and was refused only because the media
  // rule below matches neither audio nor video; from 45 it is its own
  // `display-capture` permission, which the "anything not media is granted"
  // rule would otherwise let through. Nothing in the app captures the screen
  // through the page (the screenshot tool goes through the OS, on request).
  const NEVER = new Set(["display-capture"]);
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (!ours(wc) || !details.isMainFrame) return false;
    if (NEVER.has(permission)) return false;
    if (permission !== "media") return true;
    return details.mediaType === "audio" || (details.mediaType === "video" && seesCamera(wc));
  });
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const types = permission === "media" ? ((details as Electron.MediaAccessPermissionRequest).mediaTypes ?? []) : [];
    const allow = ours(wc) && !NEVER.has(permission) && (permission !== "media"
      || ((types.includes("audio") || seesCamera(wc)) && (seesCamera(wc) || !types.includes("video"))));
    if (!allow) audit({ tool: "permission.deny", note: `${permission} [${types.join(",")}] ${String((details as Electron.PermissionRequest).requestingUrl ?? "").slice(0, 80)}` });
    callback(allow);
  });
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
  // Local side files opened from outside the workspace ("Open With", a drop, a
  // double-click in Explorer): read and written by MAIN with the credential
  // refusals above - the agent's tool jail stays workspace-scoped, and these
  // handlers answer only a trusted renderer's explicit operator action.
  ipcMain.handle("file:external", (e, op: { kind?: unknown; path?: unknown; content?: unknown }) => {
    if (!isTrustedRenderer(e)) return { ok: false, error: "untrusted sender" };
    const g = guardExternalFile(op?.path);
    if (!g.ok) return { ok: false, error: g.error };
    if (op.kind === "read") {
      try { return { ok: true, path: g.abs, content: fs.readFileSync(g.abs, "utf8") }; }
      catch (err) { return { ok: false, error: String((err as Error).message ?? err).slice(0, 160) }; }
    }
    if (op.kind === "write") {
      if (typeof op.content !== "string") return { ok: false, error: "content must be a string" };
      const tmp = `${g.abs}.ehc-tmp-${process.pid}`;
      try { fs.writeFileSync(tmp, op.content); fs.renameSync(tmp, g.abs); return { ok: true, path: g.abs }; }
      catch (err) { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ } return { ok: false, error: String((err as Error).message ?? err).slice(0, 160) }; }
    }
    return { ok: false, error: "kind must be read or write" };
  });
  // A file that arrived before any window existed (launched via "Open With").
  ipcMain.handle("file:takePending", (e) => {
    if (!isTrustedRenderer(e)) return null;
    const p = pendingExternal;
    pendingExternal = null;
    return p;
  });
  if (process.platform !== "darwin") {
    const bootFile = fileFromArgv(process.argv);
    if (bootFile) pendingExternal = bootFile;
  }
  // Pop-out windows: terminal / chat in their own OS window, same session.
  // Sweep-3: kind is allowlisted, and only trusted renderers may spawn windows.
  // Loads one of our pop-out renderer pages into a window and hardens it.
  // (The browser window reuses this for its chrome page - see ./browser.ts.)
  const loadPopoutPage = (win: BrowserWindow, kind: string, query: string): void => {
    const devIcon = path.resolve(__dirname, "../../build/icon.png");
    if (fs.existsSync(devIcon)) win.setIcon(devIcon);
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) void win.loadURL(`${devUrl}/?${query}`);
    else void win.loadFile(path.join(__dirname, "../renderer/index.html"), { search: query });
    hardenWindow(win, `popout-${kind}`);
  };
  // The browser window (S4): its own view + session, owned by main.
  initBrowser({ isTrustedRenderer, preparePopout: (win, kind) => { loadPopoutPage(win, kind, `popout=${encodeURIComponent(kind)}`); win.once("ready-to-show", () => win.show()); } });
  const POPOUT_KINDS = new Set(["terminal", "chat", "camera", "browser"]);
  ipcMain.handle("window:popout", (e, kind: string, sessionId: string, worktree?: string, url?: string) => {
    if (!isTrustedRenderer(e)) return null;
    if (typeof kind !== "string" || !POPOUT_KINDS.has(kind)) return null;
    if (typeof sessionId !== "string" || sessionId.length > 128) return null;
    if (kind === "browser") return openBrowserWindow(typeof url === "string" ? url.slice(0, 2048) : undefined);
    const win = new BrowserWindow({
      width: kind === "camera" ? 780 : 980, height: kind === "camera" ? 700 : 720,
      title: `Event Horizon - ${kind}`,
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
    loadPopoutPage(win, kind, query);
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
  ipcMain.handle("api:proxy", async (e, req: { method?: string; path?: string; body?: unknown; timeoutMs?: number }) => {
    if (!isTrustedRenderer(e)) throw new Error("Untrusted IPC sender");
    if (typeof req?.path !== "string" || !req.path.startsWith("/")) throw new Error("bad path");
    const method = (req.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("bad method");
    // The server lets a request run for 310 s before it answers 408 itself; the
    // proxy must not give up first (it used to abort at 90 s, so every slow
    // local turn came back as a 502). A turn that may wait on the operator's
    // approval asks for longer; the cap is sixteen minutes.
    const asked = Number(req.timeoutMs);
    const timeoutMs = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 16 * 60_000) : 330_000;
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
        signal: AbortSignal.timeout(timeoutMs),
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
        // The destination obeys the SAME session-worktree root as the source
        // (audit EH-SEC-9: it was contained against the server cwd, so a
        // rename could move a file out of a pinned session's worktree).
        const toGuard = contained(effectiveRoot, op.to ?? "");
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
  // "Reveal in file manager" (Explorer / Finder / xdg): same containment
  // discipline as fs:op - the path must resolve inside the session's validated
  // worktree, so a renderer can never pop an arbitrary host location.
  // An install page or a project link opens in the user's OWN browser, and
  // only if it is https on an allowlisted host (shared/externals.ts) - page
  // content can never turn a link into an arbitrary address.
  ipcMain.handle("shell:openExternal", async (e, url: unknown) => {
    if (!isTrustedRenderer(e)) return { ok: false, error: "Untrusted IPC sender" };
    const safe = typeof url === "string" ? allowedExternalUrl(url) : null;
    if (!safe) return { ok: false, error: "not an allowed address" };
    audit({ tool: "shell.openExternal", note: safe.slice(0, 120) });
    await shell.openExternal(safe);
    return { ok: true };
  });
  ipcMain.handle("shell:reveal", (e, p: unknown, root?: string) => {
    if (!isTrustedRenderer(e)) return { ok: false, error: "rejected sender" };
    const rootGuard = contained(process.cwd(), typeof root === "string" && root ? root : ".");
    if (!rootGuard.ok || !rootGuard.abs) return { ok: false, error: rootGuard.error ?? "invalid session worktree" };
    if (typeof p !== "string" || p.length === 0 || p.length > 1024) return { ok: false, error: "invalid path" };
    const guard = contained(rootGuard.abs, p);
    if (!guard.ok || !guard.abs) return { ok: false, error: guard.error ?? "path escapes the workspace" };
    if (!fs.existsSync(guard.abs)) return { ok: false, error: "not found" };
    audit({ tool: "shell.reveal", note: path.relative(rootGuard.abs, guard.abs) || "." });
    shell.showItemInFolder(guard.abs);
    return { ok: true };
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
      // Dev-mode window/taskbar icon; packaged builds get theirs baked into the
      // exe by electron-builder from build/icon.png.
      ...(fs.existsSync(path.resolve(__dirname, "../../build/icon.png"))
        ? { icon: path.resolve(__dirname, "../../build/icon.png") }
        : {}),
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
