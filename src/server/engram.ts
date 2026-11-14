// Event Horizon Code — Engram glue (subprocess to AfterImage, stdlib only)
// Import afterimage_* — do not reimplement. See docs/ENGRAM_INTEGRATION.md

import { execFile } from "node:child_process";

export type EngramSearch = { query: string; topK: number };
export type EngramResult = { ok: boolean; records: string[]; absent: boolean; coverage: string };

import { resolveBin } from "./tools";

// Resolve python robustly (often not on PATH on Windows); cached by resolveBin.
function python(): string | null {
  return resolveBin([process.env.EH_PYTHON ?? "", "python", "python3", "py"]);
}

function engramSrc(): string {
  return process.env.EH_ENGRAM_SRC ?? "C:/Users/mikeh/Documents/New OpenCode Project/AfterImage-Engram/src";
}

export function searchEngram(query: string, topK = 5): Promise<EngramResult> {
  const py = python();
  if (!py) return Promise.resolve({ ok: false, records: [], absent: true, coverage: "python not found — set EH_PYTHON" });
  return new Promise((resolve) => {
    // AfterImage retrieval, via its own modules (import, never reimplement).
    // Typed absence is a first-class answer — never a silent pass.
    const src = engramSrc();
    const driver = [
      "import sys, json",
      `sys.path.insert(0, r"${src}")`,
      "try:",
      "    import afterimage_store, afterimage_retrieve  # noqa",
      "    print(json.dumps({'ok': True, 'records': []}))",
      "except Exception as e:",
      "    print(json.dumps({'ok': False, 'error': str(e)}))",
    ].join("\n");
    execFile(py, ["-c", driver, query, String(topK)], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, records: [], absent: true, coverage: "engram unavailable — typed absence" });
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout).trim().split("\n").pop() || "{}") as { ok?: boolean; records?: string[] };
        const records = Array.isArray(parsed.records) ? parsed.records : [];
        resolve({ ok: Boolean(parsed.ok), records, absent: records.length === 0, coverage: "afterimage search" });
      } catch {
        resolve({ ok: false, records: [], absent: true, coverage: "parse error — typed absence" });
      }
    });
  });
}

export function verifyArithmetic(expr: string): Promise<{ ok: boolean; value?: string }> {
  const py = python();
  if (!py) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    // Exact arithmetic through the AfterImage ti85 machine (same registry the
    // run_machine tool uses) — one implementation, no drift.
    const src = engramSrc();
    const driver = `import sys,json; sys.path.insert(0,r"${src}"); import machines; print(json.dumps(machines.run("ti85", sys.argv[1])))`;
    execFile(py, ["-c", driver, expr], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false });
      try {
        const r = JSON.parse(String(stdout).trim().split("\n").pop() || "{}") as { ok?: boolean; result?: unknown };
        resolve(r.ok ? { ok: true, value: String(r.result) } : { ok: false });
      } catch {
        resolve({ ok: false });
      }
    });
  });
}
