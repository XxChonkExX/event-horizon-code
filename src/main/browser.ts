// Event Horizon Code - the browser window (S4), main-process side.
//
// docs/BROWSER.md: one WebContentsView in its OWN in-memory session
// (`browser`, no persist: prefix - gone when the app quits), with no preload
// and no bridge to the app. Main owns the view; the page cannot ask the app
// for anything. Every permission is denied, only public http(s) may load, and
// loopback / private ranges are never reached - by literal, by name, or by a
// hostname that resolves there. The window's own page is our chrome (address
// bar, navigation, a state line); it talks to main over IPC and nothing else.

import { BrowserWindow, WebContentsView, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { lookup } from "node:dns/promises";
import path from "node:path";
import { audit } from "../server/audit";
import { navigationAllowed, requestAllowed, hostResolvesPrivate, isPrivateOrLocalHost } from "../shared/browserPolicy";

const PARTITION = "browser";
const CHROME_MIN = 56;
const CHROME_MAX = 720;
const DNS_TTL_MS = 30_000;

export type BrowserDeps = {
  isTrustedRenderer: (e: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  /** Loads the pop-out renderer page for `kind` into the window and hardens it. */
  preparePopout: (win: BrowserWindow, kind: string) => void;
};

export type BrowserState = { url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean; secure: boolean | null; blocked: string | null };

type Tab = { win: BrowserWindow; view: WebContentsView; chromeHeight: number; blocked: string | null };
let tab: Tab | null = null;
let hardened = false;
let deps: BrowserDeps | null = null;
const dnsCache = new Map<string, { at: number; verdict: string | null }>();

function resolve(host: string): Promise<string[]> {
  return lookup(host, { all: true }).then((r) => r.map((a) => a.address));
}

/** The full request verdict: literal/name policy first, then the resolved records. */
export async function requestVerdict(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const v = requestAllowed(url);
  if (!v.ok) return v;
  const host = v.url.hostname;
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.verdict ? { ok: false, reason: hit.verdict } : { ok: true };
  const verdict = await hostResolvesPrivate(host, resolve);
  dnsCache.set(host, { at: Date.now(), verdict });
  if (dnsCache.size > 500) dnsCache.delete(dnsCache.keys().next().value as string);
  return verdict ? { ok: false, reason: verdict } : { ok: true };
}

export function hardenBrowserSession(): void {
  if (hardened) return;
  hardened = true;
  const ses = session.fromPartition(PARTITION);
  // Permissions - all denied, always, with no prompt (the workbench's own
  // windows keep their grant-by-default handler; this is the page's session).
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    audit({ tool: "browser", note: `permission refused: ${String(permission).slice(0, 40)}` });
    cb(false);
  });
  ses.setPermissionCheckHandler(() => false);
  // HID / USB / serial devices are never paired from a page (USB's protected
  // classes stay at Chromium's defaults - overriding that handler would
  // REPLACE the protected list, not extend it).
  if (typeof ses.setDevicePermissionHandler === "function") ses.setDevicePermissionHandler(() => false);
  // Network: the page may reach the internet, never this machine or the LAN.
  ses.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    void (async () => {
      const v = await requestVerdict(details.url);
      if (!v.ok) audit({ tool: "browser", note: `request cancelled: ${v.reason.slice(0, 100)}` });
      callback({ cancel: !v.ok });
    })();
  });
  // Downloads are cancelled (v1 non-goal): nothing lands on disk from a page.
  ses.on("will-download", (event) => {
    event.preventDefault();
    audit({ tool: "browser", note: "download cancelled" });
  });
}

function layout(t: Tab): void {
  if (t.win.isDestroyed()) return;
  const [w, h] = t.win.getContentSize();
  const viewH = Math.max(0, h - t.chromeHeight);
  t.view.setBounds({ x: 0, y: t.chromeHeight, width: w, height: viewH });
}

function stateOf(t: Tab): BrowserState {
  const wc = t.view.webContents;
  const url = wc.getURL();
  const secure = url.startsWith("https:") ? true : url.startsWith("http:") ? false : null;
  return { url, title: wc.getTitle(), loading: wc.isLoading(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward(), secure, blocked: t.blocked };
}

function push(t: Tab): void {
  if (t.win.isDestroyed()) return;
  try { t.win.webContents.send("browser:state", stateOf(t)); } catch { /* closing */ }
}

async function navigate(t: Tab, input: string): Promise<{ ok: boolean; error?: string }> {
  // Typed text without a scheme is a search-like address only when it names a
  // host; anything else is refused with a stated reason (no hidden search engine).
  let target = input.trim();
  if (!target) return { ok: false, error: "type an address" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) target = `https://${target}`;
  const v = navigationAllowed(target);
  if (!v.ok) {
    t.blocked = v.reason;
    audit({ tool: "browser", note: `navigation refused: ${v.reason.slice(0, 100)}` });
    push(t);
    return { ok: false, error: v.reason };
  }
  const rebinding = await requestVerdict(v.url.toString());
  if (!rebinding.ok) {
    t.blocked = rebinding.reason;
    audit({ tool: "browser", note: `navigation refused: ${rebinding.reason.slice(0, 100)}` });
    push(t);
    return { ok: false, error: rebinding.reason };
  }
  t.blocked = null;
  void t.view.webContents.loadURL(v.url.toString()).catch(() => { /* did-fail-load reports it */ });
  push(t);
  return { ok: true };
}

export function initBrowser(d: BrowserDeps): void {
  deps = d;
  ipcMain.on("browser:chrome", (e, msg: { kind?: unknown; height?: unknown }) => {
    if (!deps?.isTrustedRenderer(e) || !tab || e.sender !== tab.win.webContents) return;
    if (msg?.kind === "bounds" && typeof msg.height === "number" && Number.isFinite(msg.height)) {
      tab.chromeHeight = Math.max(CHROME_MIN, Math.min(CHROME_MAX, Math.round(msg.height)));
      layout(tab);
    }
  });
  ipcMain.handle("browser:cmd", async (e, cmd: { op?: unknown; url?: unknown }) => {
    if (!deps?.isTrustedRenderer(e) || !tab || e.sender !== tab.win.webContents) return { ok: false, error: "not the browser window" };
    const wc = tab.view.webContents;
    switch (cmd?.op) {
      case "navigate": return typeof cmd.url === "string" ? navigate(tab, cmd.url) : { ok: false, error: "url required" };
      case "back": if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return { ok: true };
      case "forward": if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return { ok: true };
      case "reload": wc.reloadIgnoringCache(); return { ok: true };
      case "stop": wc.stop(); return { ok: true };
      case "state": return { ok: true, state: stateOf(tab) };
      default: return { ok: false, error: "unknown browser command" };
    }
  });
}

/** Opens (or focuses) the one browser window. Returns the window id, like window:popout. */
export function openBrowserWindow(url?: string): number | null {
  if (!deps) return null;
  hardenBrowserSession();
  if (tab && !tab.win.isDestroyed()) {
    tab.win.focus();
    if (url) void navigate(tab, url);
    return tab.win.id;
  }
  const win = new BrowserWindow({
    width: 1120, height: 780, title: "Event Horizon - Browser", show: false, autoHideMenuBar: true,
    // The window's own page is OUR chrome and gets the bridge preload; the
    // VIEW below is created separately with none.
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "../preload/index.js") },
  });
  const ses = session.fromPartition(PARTITION);
  const view = new WebContentsView({
    webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webviewTag: false, devTools: false, spellcheck: false, // the page gets no devtools and may not nest webviews
    },
  });
  win.contentView.addChildView(view);
  view.setBackgroundColor("#131318");
  // WebRTC never leaks local addresses or bypasses the request guard.
  if (typeof view.webContents.setWebRTCIPHandlingPolicy === "function") view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  tab = { win, view, chromeHeight: 220, blocked: null };
  // The view's own guards: renderer-initiated navigations and redirects are
  // re-checked (the session guard already cancels the requests), new windows
  // never open, and webviews never attach.
  view.webContents.setWindowOpenHandler(({ url: u }) => {
    audit({ tool: "browser", note: `window.open denied: ${hostOf(u)}` });
    return { action: "deny" };
  });
  const guard = (e: { preventDefault: () => void }, u: string): void => {
    const v = navigationAllowed(u);
    if (!v.ok) { e.preventDefault(); tab && (tab.blocked = v.reason); audit({ tool: "browser", note: `navigation refused: ${v.reason.slice(0, 100)}` }); push(tab!); }
  };
  view.webContents.on("will-navigate", guard);
  view.webContents.on("will-redirect", guard);
  view.webContents.on("will-attach-webview", (e) => e.preventDefault());
  view.webContents.on("will-prevent-unload", (e) => e.preventDefault()); // a page cannot hold the window hostage
  const events = view.webContents as unknown as { on(ev: string, fn: () => void): void };
  for (const ev of ["did-navigate", "did-navigate-inpage", "page-title-updated", "did-start-loading", "did-stop-loading", "did-fail-load", "did-finish-load"]) {
    events.on(ev, () => { if (tab) { layout(tab); push(tab); } });
  }
  win.on("resize", () => tab && layout(tab));
  win.on("closed", () => {
    // The view dies with its window; nothing of the page survives.
    try { view.webContents.close(); } catch { /* already gone */ }
    tab = null;
  });
  deps.preparePopout(win, "browser");
  // The start page: about:blank until the operator types an address.
  void view.webContents.loadURL("about:blank").catch(() => { /* nothing to show yet */ });
  win.show();
  if (url) void navigate(tab, url);
  return win.id;
}

function hostOf(u: string): string {
  try { return new URL(u).hostname || "(none)"; } catch { return "(not a URL)"; }
}

export function browserState(): BrowserState | null {
  return tab && !tab.win.isDestroyed() ? stateOf(tab) : null;
}

// Kept for the tests' expectations and future tool lane: the one predicate
// every other guard reduces to.
export { isPrivateOrLocalHost };
