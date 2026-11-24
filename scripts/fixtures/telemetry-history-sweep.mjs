// Telemetry history sweep: was any analytics/beacon/updater symbol EVER added
// to the repo history (added by any contributor or model-authored commit)?
import { execFileSync } from "node:child_process";

const terms = ["sendBeacon", "electron-updater", "autoUpdater", "posthog", "mixpanel", "amplitude", "getsentry", "sentry", "gtag(", "googletagmanager", "setFeedURL", "telemetry.enable", "telemetryEnabled", "applicationInsights", "datadog"];
for (const term of terms) {
  let hits = "";
  try {
    hits = execFileSync("git", ["log", "--all", "--oneline", "-i", "-S", term], { encoding: "utf8" }).trim();
  } catch { /* none */ }
  const lines = hits ? hits.split("\n") : [];
  console.log(term.padEnd(20), lines.length ? `${lines.length} commit(s): ${lines.slice(0, 3).join(" | ").slice(0, 150)}` : "never in history");
}
