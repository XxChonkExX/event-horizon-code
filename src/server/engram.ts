// Event Horizon Code — Engram glue (subprocess to AfterImage, stdlib only)
// Import afterimage_* — do not reimplement. See docs/ENGRAM_INTEGRATION.md

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type EngramSearch = { query: string; topK: number };
export type EngramResult = { ok: boolean; records: string[]; absent: boolean; coverage: string };

import { resolveBin } from "./tools";

// Resolve python robustly (often not on PATH on Windows); cached by resolveBin.
function python(): string | null {
  return resolveBin([process.env.EH_PYTHON ?? "", "python", "python3", "py"]);
}

/** Where AfterImage's src lives: explicit env, sibling checkout, in-workspace copy. The one resolver for every consumer (audit EH-SEC-8). */
export function resolveEngramSrc(): string {
  // Portable order (audit EH-SEC-8: a dev-machine absolute path shipped in
  // source and pointed nowhere on any other machine): explicit env, sibling
  // checkout, in-workspace copy. tools.ts's run_machine resolves the same way.
  const candidates = [
    process.env.EH_ENGRAM_SRC ?? "",
    path.join(process.cwd(), "..", "AfterImage-Engram", "src"),
    path.join(process.cwd(), "AfterImage-Engram", "src"),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const abs = path.resolve(c);
    try { if (fs.existsSync(path.join(abs, "machines.py"))) return abs; } catch { /* next */ }
  }
  return process.env.EH_ENGRAM_SRC ?? "";
}

function engramSrc(): string {
  return resolveEngramSrc();
}

function engramDb(): string {
  return process.env.EH_ENGRAM_DB ?? `${process.env.USERPROFILE ?? process.env.HOME ?? "."}\\.eventhorizon\\engram.db`;
}

function engramSession(): string {
  return process.env.EH_ENGRAM_SESSION ?? "ehc";
}

// Shared driver prelude: open the store, ensure the session exists.
function storePrelude(src: string, db: string): string {
  const art = db.replace(/[^\\/]+$/, "engram-artifacts");
  return [
    "import sys, json",
    `sys.path.insert(0, r"${src}")`,
    "from afterimage_store import SessionStore",
    "from afterimage_api import SessionAPI",
    `store = SessionStore(r"${db}", r"${art}")`,
    `try:`,
    `    store.create_session(r"${engramSession()}", "event-horizon", "ehc-agent")`,
    "except Exception:",
    "    pass",
    "api = SessionAPI(store)",
  ].join("\n");
}

export function searchEngram(query: string, topK = 5): Promise<EngramResult> {
  const py = python();
  if (!py) return Promise.resolve({ ok: false, records: [], absent: true, coverage: "python not found — set EH_PYTHON" });
  return new Promise((resolve) => {
    // AfterImage retrieval via its own API (import, never reimplement).
    // Typed absence is a first-class answer — never a silent pass.
    const driver = `${storePrelude(engramSrc(), engramDb())}\nprint(json.dumps(api.ask(sys.argv[1], sys.argv[2], k=int(sys.argv[3]))))`;
    execFile(py, ["-c", driver, engramSession(), query, String(topK)], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, records: [], absent: true, coverage: "engram unavailable — typed absence" });
        return;
      }
      try {
        const parsed = JSON.parse(String(stdout).trim().split("\n").pop() || "{}") as { status?: string; records?: string[]; note?: string };
        if (parsed.status === "records") {
          resolve({ ok: true, records: parsed.records ?? [], absent: false, coverage: "afterimage records" });
        } else {
          resolve({ ok: true, records: [], absent: true, coverage: parsed.note ?? "certified absence" });
        }
      } catch {
        resolve({ ok: false, records: [], absent: true, coverage: "parse error — typed absence" });
      }
    });
  });
}

export function registerEngram(texts: string[]): Promise<{ ok: boolean; n: number }> {
  const py = python();
  if (!py) return Promise.resolve({ ok: false, n: 0 });
  return new Promise((resolve) => {
    // Append verbatim records to the store of record (append-only, per AfterImage).
    const driver = [
      storePrelude(engramSrc(), engramDb()),
      "texts = json.loads(sys.argv[1])",
      `store.add_records(r"${engramSession()}", texts)`,
      "print(json.dumps({'ok': True, 'n': len(texts)}))",
    ].join("\n");
    execFile(py, ["-c", driver, JSON.stringify(texts)], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, n: 0 });
      try {
        const r = JSON.parse(String(stdout).trim().split("\n").pop() || "{}") as { ok?: boolean; n?: number };
        resolve({ ok: Boolean(r.ok), n: r.n ?? 0 });
      } catch {
        resolve({ ok: false, n: 0 });
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
