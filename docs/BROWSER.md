# A minimal, hardened browser window (S4) - design

**Status: B1 SHIPPED (2026-11-27) - the hardened window: its own in-memory session, every permission denied, only public http(s), loopback/private unreachable by literal, name or resolved record, no bridge, downloads cancelled, verified from inside the page in the real window.** The agent tools (rowser_*), the driving banner and auto-confirm are designed and next. Researched 2026-11-26; sources at the end.

Operator's direction: "really minimal and lightweight but something we can control, make private, and with air-tight security mindedness and local control baked in ... harden but still usable and featherweight."

## 1. Goals and non-goals

| Goal | Means |
|---|---|
| Featherweight | Zero added bytes. EHC already ships Chromium; the browser uses that, not a second engine. |
| Private | Its own session: no shared cookies, storage, cache or permissions with the workbench. Ephemeral unless the user says otherwise. |
| Controlled | The page has no bridge to the app. The main process owns the view; the page cannot ask the app for anything. |
| Agent-drivable | A narrow set of tools (`navigate`, `read`, `click`, `type`), each permission `ask`, acting on text - not on pixels. |
| Local control | No cloud service, no account, no sync, no telemetry from the browser itself. |

Non-goals for v1: extensions, saved passwords, downloads, DRM video, devtools, being anyone's daily driver.

## 2. Engine: use the Chromium that is already here

| Option | Verdict | Why |
|---|---|---|
| Electron `WebContentsView` | **Use** | Electron's documented way to embed web content: created, positioned and controlled by the main process, not in the page. Costs nothing extra. |
| Electron `<webview>` tag | No | Electron's own guide advises against it ("dramatic architectural changes"). |
| Sandboxed `<iframe>` | No | Lives inside the workbench page; wrong trust boundary for arbitrary sites. |
| WebKitGTK / WPE | No | Mature and small, but Linux-only. |
| Servo | Not yet | Embedding-first and memory-safe (Rust, MPL-2.0), but still described as a prototype; process sandbox exists only on Linux/macOS and is off by default. Worth revisiting. |
| Ladybird | No | Pre-alpha. |
| CEF, Ultralight | No | Another 150-250 MB of Chromium, or a commercial licence, for the engine we already have. |

Chromium's own process model does the heavy lifting: each site gets a sandboxed renderer with no direct filesystem or network access.

## 3. Shape

- A **"browser" pop-out window** (the existing pop-out mechanism, a fourth allowlisted kind) holding one `WebContentsView` plus about 120 px of our own UI: address bar, back / forward / reload / stop, a lock icon, and a banner when the agent is driving.
- Its webContents live in `session.fromPartition("browser")` - **never the default session** the workbench uses. Without the `persist:` prefix the partition is in-memory and gone on close; "keep site data between runs" would be an explicit setting.
- Created with no preload script, `sandbox: on`, `contextIsolation: on`, `nodeIntegration: off`. There is no `window.eventhorizon` in that page.
- Communication is one-way: our UI sends commands to the main process, the main process tells the view what to do. The page's only outputs are what the main process chooses to read back from it.

## 4. Hardening list

Each item is a test before it is a line of code.

**S4.0 - close a gap that exists today.** The permission *check* handler currently answers "granted" for non-media permissions to any webContents; only the *request* handler checks that the sender is one of our windows. It is unreachable now (the renderer's CSP forbids remote frames and navigation is blocked), but it must be closed before any web content can exist: a webContents that is not ours gets nothing at the check stage too.

**Navigation and content**

- Only `http:` and `https:` may be loaded. `file:`, `chrome:`, `javascript:` at top level, custom schemes and `view-source:` are cancelled.
- `window.open` and target=_blank never create windows.
- Downloads are cancelled unless the user turns them on, and then go through a save dialog.
- DevTools, remote debugging and the menu bar are off in this window.

**Permissions - all denied, always**

- Camera, microphone, geolocation, notifications, clipboard read, MIDI, USB, serial, HID, pointer lock, fullscreen: refused for the browser session, with no prompt. (The workbench's own windows are unaffected; see `docs/SECURITY.md`.)

**Network - the page may reach the internet, never the app**

- Requests to loopback and private ranges (`127.0.0.1`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `.local`, `.internal`) are cancelled in the browser session, so a page cannot reach the local runtime, Ollama, or a LAN llama-server. The runtime's per-launch password stays the second lock.
- Mixed content and insecure downloads follow Chromium's defaults (blocked).
- Optional, off by default: a small local block list for known telemetry hosts, matched in `onBeforeRequest`. No filter list is fetched unless the user clicks, and the same pinned-catalog rule applies as for models.

**Agent control - narrow and gated**

| Tool | Does | Permission |
|---|---|---|
| `browser_navigate { url }` | loads a page after the same scheme checks | `ask` |
| `browser_read { }` | returns the page as text from the accessibility tree - not a screenshot | `ask` |
| `browser_click { ref }` / `browser_type { ref, text }` | act on elements the read returned, by reference | `ask` |
| `browser_scroll { }`, `browser_back { }` | the obvious | `ask` |

- Rate-limited, one page at a time, and visible: the window shows "agent is driving" and a Stop button for the user.
- Everything the browser returns is **untrusted data** to the model: wrapped and labelled as such, never as instructions. This is the same rule as `webfetch` today, extended to something the agent can steer.
- Typing into a field is `ask` every time — including credential fields, which the operator decision of 2026-11-26 allows with that explicit per-field approval (a phished page can only get credentials one approved field at a time). Payment forms stay refused in v1 with a stated reason.
- The agent gets no direct network access through the browser - only what `browser_read` returns.

**State**

- Ephemeral by default. Cookies, cache and history die with the window unless "keep site data" is on; history is local, listed, and deletable in the panel.

## 5. Threat model in one table

| Threat | Control |
|---|---|
| A hostile page attacks the workbench | separate session, no preload, no IPC to the app, separate window |
| A hostile page reaches the local runtime or LAN services | loopback and private-range requests cancelled; runtime password |
| A hostile page turns on the camera or reads the clipboard | every permission denied for the session, no prompt |
| A page-injected instruction hijacks the agent | browser output labelled untrusted; each action is `ask`; visible driving banner and Stop |
| The agent types credentials | every field is `ask` (allowed by operator decision 2026-11-26) |
| The agent types into a payment form | refused in v1 with a stated reason |
| Drive-by downloads and pop-ups | downloads cancelled by default; no new windows |
| Silent tracking across runs | ephemeral session by default; optional local block list |

## 6. Tests, before "done"

Permission denial matrix for the browser session; scheme policy; `window.open` denied; download cancelled; loopback and each private range cancelled (with a loopback stub proving it was never contacted); the workbench's own permissions unchanged; every tool `ask`-gated; site data absent after close.

## 7. Decisions

**Recorded (operator, 2026-11-26):** both modes ship, and they differ only in how often the user is asked.

| Mode | Behaviour | Who gets it |
|---|---|---|
| **Ask every step** (default) | every `navigate` / `click` / `type` waits for the user | core |
| **Auto-confirm** | one click arms a bounded loop: at most **4 steps** or a fixed time limit, whichever comes first; the driving banner counts down and Stop ends it at once. `type` still asks when the field looks like a payment form | core |
| Longer and unattended loops | beyond the 4-step / timed loop | the premium line, not the core |

This keeps the base philosophy - the agent never runs ahead of the user's consent - while leaving room for automation as a paid convenience.

**Still open:**
1. Keep site data between runs: off by default (recommended) or on?
2. Should the agent ever log in to sites? Recommended: not in v1.

## Sources

- Electron web-embeds guide (github.com/electron/electron, `docs/tutorial/web-embeds.md`).
- "Ladybird vs Servo vs WebKitGTK in 2026", pistack.xyz (September 2026); servo.org and the Servo "building a browser" post (multi-process and sandboxing status).
- BlinkGTK engine comparison (measured footprint of a second Chromium); Superkraft engine comparison table.
- "Make a Web Browser: From WebView2 Apps to Chromium Forks", w3reference.com (November 2026) - on Chromium's process and site isolation.
