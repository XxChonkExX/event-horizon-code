#!/usr/bin/env node
// Event Horizon Code - Linux desktop integration installer.
//
// Installs what the manual setup did by hand on the alpha machine, so any
// Linux box gets the same result:
//   - build/icon.png -> ~/.local/share/icons/hicolor/{size}/apps/event-horizon-code.png
//   - ~/.local/share/applications/event-horizon-code.desktop (Exec/Path derived
//     from this repo's location; StartupWMClass = package name so the running
//     window merges into the dock icon instead of spawning a generic one)
//   - refreshes the desktop database and (best effort, GNOME only) pins the
//     launcher to the dock favorites.
//
// Idempotent: safe to re-run after moving the repo (paths regenerate).
// Uninstall: node scripts/install-linux-desktop.mjs --uninstall
//
// Packaged builds (pack / pack:dir) ship their own .desktop entries and do not
// need this script; this is for running from a source checkout.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const APP_ID = pkg.name; // event-horizon-code - must match Electron's Wayland app_id
const DESKTOP = path.join(os.homedir(), ".local/share/applications", `${APP_ID}.desktop`);
const ICON_DIR = path.join(os.homedir(), ".local/share/icons");
const ICON_SRC = path.join(REPO, "build", "icon.png");
const SIZES = [256, 128, 64, 48, 32];
const ELECTRON_BIN = path.join(REPO, "node_modules", "electron", "dist", "electron");
const say = (m) => console.log(`[ehc-desktop] ${m}`);
const fail = (m) => { console.error(`[ehc-desktop] FAIL: ${m}`); process.exit(1); };

const unlink = (p) => { try { fs.rmSync(p, { force: true }); } catch { /* gone */ } };

if (process.argv.includes("--uninstall")) {
  unlink(DESKTOP);
  for (const s of SIZES) unlink(path.join(ICON_DIR, `${s}x${s}/apps`, `${APP_ID}.png`));
  say("removed .desktop entry and hicolor icons");
  try { execFileSync("update-desktop-database", [path.join(os.homedir(), ".local/share/applications")]); } catch { /* optional tool */ }
  say("uninstalled (remove the dock pin manually if you had one)");
  process.exit(0);
}

if (!fs.existsSync(ICON_SRC)) fail(`no icon at ${ICON_SRC} - the repo should ship build/icon.png`);
if (!fs.existsSync(ELECTRON_BIN)) fail(`electron not found at ${ELECTRON_BIN} - run npm install first`);

// Icon: hicolor theme entries at every useful size.
for (const s of SIZES) {
  const dest = path.join(ICON_DIR, `${s}x${s}/apps`, `${APP_ID}.png`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(ICON_SRC, dest); // source is 256px; smaller sizes scale at render time
  say(`icon ${s}x${s} -> ${dest}`);
}

// Launcher. Exec calls the electron binary directly: the source checkout has
// no AppImage wrapper, and the session shell that GNOME spawns for the dock
// already carries DISPLAY/WAYLAND_DISPLAY (main/index.ts refuses plainly if not).
const entry = `[Desktop Entry]
Type=Application
Version=1.0
Name=${pkg.productName ?? "Event Horizon Code"}
GenericName=Coding Agent Harness
Comment=${(pkg.description ?? "Local-first coding agent harness").replace(/\n/g, " ")}
Exec=${ELECTRON_BIN} ${REPO}
Path=${REPO}
Icon=${APP_ID}
Terminal=false
Categories=Development;IDE;
StartupWMClass=${APP_ID}
StartupNotify=true
`;
fs.mkdirSync(path.dirname(DESKTOP), { recursive: true });
fs.writeFileSync(DESKTOP, entry);
say(`launcher -> ${DESKTOP}`);

try { execFileSync("update-desktop-database", [path.join(os.homedir(), ".local/share/applications")]); say("desktop database refreshed"); }
catch { say("update-desktop-database not present - GNOME will pick the entry up on next login"); }

// Dock pin (GNOME only, best effort - never fail the install over cosmetics).
try {
  const out = execFileSync("gsettings", ["get", "org.gnome.shell", "favorite-apps"], { encoding: "utf8", timeout: 5000 });
  const list = JSON.parse(out.trim().replace(/'/g, '"'));
  if (!list.includes(`${APP_ID}.desktop`)) {
    list.push(`${APP_ID}.desktop`);
    execFileSync("gsettings", ["set", "org.gnome.shell", "favorite-apps", JSON.stringify(list).replace(/"/g, "'")], { timeout: 5000 });
    say("pinned to GNOME dock favorites");
  } else say("already pinned to GNOME dock favorites");
} catch { say("gsettings/GNOME not detected - pin the dock entry manually if desired"); }

say("done - launch from the dock or: gtk-launch " + APP_ID);
