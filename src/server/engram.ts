// Event Horizon Code — Engram glue (subprocess to AfterImage, stdlib only)
// Import afterimage_* — do not reimplement. See docs/ENGRAM_INTEGRATION.md

import { execFile } from "node:child_process";

export type EngramSearch = { query: string; topK: number };
export type EngramResult = { ok: boolean; records: string[]; absent: boolean; coverage: string };

function python(): string { return process.env.PYTHON ?? "python"; }

export function searchEngram(query: string, topK = 5): Promise<EngramResult> {
  return new Promise((resolve) => {
    // AfterImage CLI shape: python -m afterimage_api search --query ... --top-k ...
    // If absent, return typed absence (never a silent pass).
    execFile(python(), ["-m", "afterimage_api", "search", "--query", query, "--top-k", String(topK)], { timeout: 8000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, records: [], absent: true, coverage: "engram unavailable — typed absence" });
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout)) as { records?: string[] };
        const records = Array.isArray(parsed.records) ? parsed.records : [];
        resolve({ ok: true, records, absent: records.length === 0, coverage: "afterimage search" });
      } catch {
        resolve({ ok: false, records: [], absent: true, coverage: "parse error — typed absence" });
      }
    });
  });
}

export function verifyArithmetic(expr: string): Promise<{ ok: boolean; value?: string }> {
  return new Promise((resolve) => {
    execFile(python(), ["-m", "afterimage_ti85", "eval", expr], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve({ ok: false });
      resolve({ ok: true, value: String(stdout).trim() });
    });
  });
}
