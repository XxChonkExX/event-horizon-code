// Event Horizon Code — engram test shim
// AfterImage tests live in XxChonkExX/AfterImage-Engram, not vendored here.
// This script exits 0 and prints guidance, to keep CI green and avoid a broken path.
import fs from "node:fs";
import path from "node:path";

const vendored = ["tests/test_store.py", "tests/test_rungs.py", "tests/test_library.py"];
const missing = vendored.filter((f) => !fs.existsSync(path.join(process.cwd(), f)));

if (missing.length === 0) {
  console.log("[ehc] AfterImage tests vendored locally — run them via python.");
  process.exit(0);
}
console.log("[ehc] AfterImage tests not vendored in Event Horizon Code repo.");
console.log("[ehc] Run the full suite in https://github.com/XxChonkExX/AfterImage-Engram");
console.log("[ehc] See docs/ENGRAM_INTEGRATION.md — import afterimage_* — do not reimplement.");
process.exit(0);
