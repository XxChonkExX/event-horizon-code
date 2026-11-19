// scripts/install-windows-desktop.mjs - Windows desktop/Start Menu shortcuts.
// Windows mirror of install-linux-desktop.mjs: creates a Desktop shortcut and
// a Start Menu shortcut pointing at the app, with the event-horizon artwork as
// the icon. Idempotent; --uninstall removes both.
//
// Taskbar pinning is not scriptable reliably on Windows 11 - after install,
// right-click either shortcut and choose "Pin to taskbar".
//
// Usage:
//   node scripts/install-windows-desktop.mjs               # install
//   node scripts/install-windows-desktop.mjs --uninstall   # remove shortcuts

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const REPO = process.cwd();
const APP_NAME = "Event Horizon Code";
const SHORTCUT_NAME = `${APP_NAME}.lnk`;

// Where the app exe might live, first hit wins: NSIS per-user install
// location, then the local release-candidate build.
const candidates = [
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", APP_NAME, `${APP_NAME}.exe`),
  path.join(REPO, "dist", "win-unpacked", `${APP_NAME}.exe`),
];

const exe = candidates.map((c) => path.resolve(c)).find((c) => fs.existsSync(c));
if (!exe) {
  console.error(`[ehc] no app executable found. Looked in:\n  ${candidates.join("\n  ")}`);
  console.error("[ehc] build one first: npm run pack:dir");
  process.exit(1);
}

// PNG -> ICO (Vista+ supports PNG-compressed entries): 6-byte header, one
// 16-byte directory entry marking 256x256, then the raw PNG bytes.
function ensureIco() {
  const icoPath = path.join(REPO, "build", "icon.ico");
  const png = fs.readFileSync(path.join(REPO, "build", "icon.png"));
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  header.writeUInt8(0, 6); // width 0 = 256
  header.writeUInt8(0, 7); // height 0 = 256
  header.writeUInt8(0, 8); // palette
  header.writeUInt8(0, 9); // reserved
  header.writeUInt16LE(1, 10); // color planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14); // data size
  header.writeUInt32LE(22, 18); // data offset
  fs.writeFileSync(icoPath, Buffer.concat([header, png]));
  return icoPath;
}

function psQuote(s) {
  return s.replace(/'/g, "''");
}

function createShortcut(lnkPath) {
  const icoPath = ensureIco();
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$lnk = $ws.CreateShortcut('${psQuote(lnkPath)}')`,
    `$lnk.TargetPath = '${psQuote(exe)}'`,
    `$lnk.IconLocation = '${psQuote(icoPath)},0'`,
    `$lnk.WorkingDirectory = '${psQuote(path.dirname(exe))}'`,
    "$lnk.Save()",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
}

const desktopDir = execFileSync(
  "powershell.exe",
  ["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"],
  { encoding: "utf8" }
).trim();
const startMenuDir = path.join(
  process.env.APPDATA ?? "",
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs"
);
const desktopLnk = path.join(desktopDir, SHORTCUT_NAME);
const startMenuLnk = path.join(startMenuDir, SHORTCUT_NAME);

if (process.argv.includes("--uninstall")) {
  let removed = 0;
  for (const lnk of [desktopLnk, startMenuLnk]) {
    if (fs.existsSync(lnk)) {
      fs.rmSync(lnk, { force: true });
      removed++;
      console.log(`[ehc] removed ${lnk}`);
    }
  }
  console.log(`[ehc] done - ${removed} shortcut(s) removed.`);
  process.exit(0);
}

for (const lnkPath of [desktopLnk, startMenuLnk]) {
  createShortcut(lnkPath);
  console.log(`[ehc] created ${lnkPath}`);
}

console.log(`[ehc] done. Shortcuts point at: ${exe}`);
console.log(
  "[ehc] pin to taskbar: right-click either shortcut and choose 'Pin to taskbar' (Windows restricts scriptable pinning)."
);
