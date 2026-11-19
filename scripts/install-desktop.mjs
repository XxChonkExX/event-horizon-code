// scripts/install-desktop.mjs - platform dispatcher for desktop/Start Menu
// (Windows) or dock/launcher (Linux) shortcuts. One command, both platforms.
// Usage:
//   node scripts/install-desktop.mjs               # install
//   node scripts/install-desktop.mjs --uninstall   # remove shortcuts

import { spawnSync } from "node:child_process";
import path from "node:path";

const script = process.platform === "win32"
  ? "install-windows-desktop.mjs"
  : "install-linux-desktop.mjs";

const r = spawnSync(process.execPath, [path.join("scripts", script), ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
