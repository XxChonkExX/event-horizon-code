// Event Horizon Code - Auto-memory extraction
//
// Claude Code-style auto-memory, adapted to the operator-review-first rule:
// after (or during) a session, the agent can PROPOSE durable project-memory
// entries from the conversation. Nothing is written automatically - proposals
// are returned to the UI, and only operator-approved lines are appended to
// .harness/memory.md (which replays in every future session's system prompt).

import fs from "node:fs";
import path from "node:path";
import { audit } from "./audit";
import { loadMessages } from "./store";
import { chat, chatOpenAI } from "./router";
import { engineEndpoint } from "./engine";

function memoryPath(workdir: string): string {
  return path.join(workdir, ".harness", "memory.md");
}

export function existingMemoryLines(workdir: string): string[] {
  try {
    return fs.readFileSync(memoryPath(workdir), "utf8")
      .split("\n")
      .map((l) => l.replace(/^- /, "").trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch { return []; }
}

export type ExtractResult = { ok: boolean; proposals?: string[]; error?: string };

// One cheap model call over the session digest. No tools, no writes.
export async function extractMemories(sessionId: string, workdir: string, opts?: { model?: string; timeoutMs?: number }): Promise<ExtractResult> {
  const msgs = loadMessages(sessionId);
  if (msgs.length < 2) return { ok: false, error: "not enough conversation to extract from (need at least a user + assistant turn)" };
  const digest = msgs.map((m) => `[${m.role}] ${m.content}`).join("\n").slice(0, 20_000);
  const existing = existingMemoryLines(workdir);
  const system = [
    "You extract durable project memory from a coding session.",
    "Return 0-3 lines. Each line: a single durable fact, convention, or decision worth remembering for EVERY future session in this workspace",
    "(build commands, style rules, deployment steps, user preferences).",
    "Do not include transient details (specific bug fixes, file dumps, pleasantries).",
    "Do not repeat anything from the KNOWN list.",
    "Output format: one line per memory, no bullets, no numbering, no preamble.",
    "If nothing qualifies, output exactly: NOTHING",
  ].join("\n") + (existing.length ? `\n\nKNOWN (do not repeat):\n${existing.map((l) => `- ${l}`).join("\n").slice(0, 4000)}` : "");

  const engineUp = engineEndpoint();
  let r;
  if (engineUp) {
    r = await chatOpenAI(opts?.model || "engine", [
      { role: "system", content: system },
      { role: "user", content: digest },
    ], { baseUrl: engineUp, apiKey: "local", think: "low", numPredict: 512, timeoutMs: opts?.timeoutMs ?? 120_000 });
  } else if (opts?.model) {
    r = await chat(opts.model, [
      { role: "system", content: system },
      { role: "user", content: digest },
    ], { think: "low", numPredict: 512, timeoutMs: opts?.timeoutMs ?? 120_000 });
  } else {
    return { ok: false, error: "no model available - start the engine or pass a model to extract memories" };
  }

  if (!r.ok) return { ok: false, error: `memory extraction failed: ${(r.error ?? "").slice(0, 200)}` };
  const lines = (r.content ?? "")
    .split("\n")
    .map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
    .filter((l) => l.length > 8 && l.length <= 300 && !/^NOTHING$/i.test(l));
  // Dedupe against what memory already holds (case-insensitive contains).
  const known = existing.map((l) => l.toLowerCase());
  const proposals = Array.from(new Set(lines)).filter((l) => !known.some((k) => k === l.toLowerCase() || (l.length > 30 && k.includes(l.toLowerCase().slice(0, 30)))));
  audit({ tool: "memory.extract", note: `${sessionId}: ${proposals.length} proposal(s)` });
  return { ok: true, proposals: proposals.slice(0, 3) };
}

// Operator-approved application. Only ever called with explicit lines.
export function applyMemories(workdir: string, texts: string[]): { ok: boolean; added: number; error?: string } {
  const clean = (texts ?? []).map((t) => String(t).trim().replace(/^-\s*/, "")).filter((t) => t.length > 4 && t.length <= 300);
  if (!clean.length) return { ok: false, added: 0, error: "no usable memory lines" };
  const p = memoryPath(workdir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, "# Project memory (written by the agent)\n\n");
  const known = new Set(existingMemoryLines(workdir).map((l) => l.toLowerCase()));
  let added = 0;
  for (const t of clean) {
    if (known.has(t.toLowerCase())) continue;
    fs.appendFileSync(p, `- ${t}\n`);
    known.add(t.toLowerCase());
    added++;
  }
  audit({ tool: "memory.apply", note: `${added} line(s)` });
  return { ok: true, added };
}
