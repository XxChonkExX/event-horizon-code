// Event Horizon Code — Session store (SQLite WAL)
// Minimal: sessions + todos. better-sqlite3 is a declared dep but lazy-loaded
// so startup works without native build. In-memory fallback in dev.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type Session = { id: string; title: string; worktree: string; created: string; lastActivity?: string | null };
export type Todo = { id: string; sessionId: string; text: string; done: boolean };

let db: any | null = null;
let memSessions: Session[] = [];
let memTodos: Todo[] = [];

function dbPath() {
  return process.env.EH_DB ?? path.join(os.homedir(), ".eventhorizon", "data.db");
}

export function initStore(): { mode: "sqlite" | "memory" } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const p = dbPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    db = new Database(p);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, worktree TEXT, created TEXT, lastActivity TEXT);" +
      "CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, sessionId TEXT, text TEXT, done INTEGER);" +
      "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sessionId TEXT, seq INTEGER, role TEXT, content TEXT, ts TEXT, toolCalls TEXT, toolCallId TEXT, toolName TEXT);" +
      "CREATE TABLE IF NOT EXISTS instructions (sessionId TEXT, key TEXT, text TEXT, ts TEXT, PRIMARY KEY (sessionId, key));" +
      "CREATE TABLE IF NOT EXISTS usage (sessionId TEXT, model TEXT, tokens INTEGER, ts TEXT);" +
      "CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT, settings TEXT, created TEXT);" +
      "CREATE TABLE IF NOT EXISTS checkpoints (sessionId TEXT, seq INTEGER, label TEXT, ts TEXT);" +
      "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, sessionId TEXT, objective TEXT, workdir TEXT, state TEXT, lane TEXT, model TEXT, started TEXT, updated TEXT, ended TEXT, error TEXT, result TEXT);" +
      "CREATE TABLE IF NOT EXISTS run_events (runId TEXT, seq INTEGER, ts TEXT, kind TEXT, detail TEXT, PRIMARY KEY (runId, seq));"
    );
    // Migration: older DBs predate the lastActivity column.
    try { db.exec("ALTER TABLE sessions ADD COLUMN lastActivity TEXT"); } catch { /* already present */ }
    // Migration (external audit Finding A): older DBs predate the tool-call
    // protocol columns. Content-only history replays as invalid OpenAI
    // protocol (orphaned tool responses) on providers that validate it.
    try { db.exec("ALTER TABLE messages ADD COLUMN toolCalls TEXT"); } catch { /* already present */ }
    try { db.exec("ALTER TABLE messages ADD COLUMN toolCallId TEXT"); } catch { /* already present */ }
    try { db.exec("ALTER TABLE messages ADD COLUMN toolName TEXT"); } catch { /* already present */ }
    return { mode: "sqlite" };
  } catch (e) {
    // P1 (sweep 3): a silent memory fallback makes storage failure LOOK like a
    // successful session - sessions would silently vanish on restart. Fail
    // loudly here; callers keep their honest in-memory degradation.
    db = null;
    console.error(`[ehc] FATAL: SQLite initialization failed - falling back to VOLATILE MEMORY. Sessions, messages and profiles will NOT survive a restart. Cause: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return { mode: "memory" };
  }
}

export function listSessions(): Session[] {
  if (db) return db.prepare("SELECT * FROM sessions").all() as Session[];
  return memSessions;
}

export function createSession(s: Session): Session {
  if (db) db.prepare("INSERT INTO sessions (id,title,worktree,created) VALUES (?,?,?,?)").run(s.id, s.title, s.worktree, s.created);
  else memSessions.push(s);
  return s;
}

export function listTodos(sessionId: string): Todo[] {
  if (db) {
    const rows = db.prepare("SELECT * FROM todos WHERE sessionId=?").all(sessionId) as Array<{ id: string; sessionId: string; text: string; done: number }>;
    return rows.map((r) => ({ id: r.id, sessionId: r.sessionId, text: r.text, done: r.done === 1 }));
  }
  return memTodos.filter((t) => t.sessionId === sessionId);
}

export function addTodo(t: Todo): Todo {
  if (db) db.prepare("INSERT INTO todos (id,sessionId,text,done) VALUES (?,?,?,?)").run(t.id, t.sessionId, t.text, t.done ? 1 : 0);
  else memTodos.push(t);
  return t;
}

export function toggleTodo(id: string, done: boolean): void {
  if (db) db.prepare("UPDATE todos SET done=? WHERE id=?").run(done ? 1 : 0, id);
  else {
    const t = memTodos.find((x) => x.id === id);
    if (t) t.done = done;
  }
}

// ---- session instructions (durable memory that survives compaction) ----

export type Instruction = { key: string; text: string };

const memInstructions = new Map<string, Map<string, string>>();

export function putInstruction(sessionId: string, key: string, text: string): void {
  if (db) {
    db.prepare("INSERT INTO instructions (sessionId,key,text,ts) VALUES (?,?,?,?) ON CONFLICT(sessionId,key) DO UPDATE SET text=excluded.text, ts=excluded.ts")
      .run(sessionId, key, text, new Date().toISOString());
  } else {
    if (!memInstructions.has(sessionId)) memInstructions.set(sessionId, new Map());
    memInstructions.get(sessionId)!.set(key, text);
  }
}

export function listInstructions(sessionId: string): Instruction[] {
  if (db) return db.prepare("SELECT key, text FROM instructions WHERE sessionId=? ORDER BY ts").all(sessionId) as Instruction[];
  const m = memInstructions.get(sessionId);
  return m ? Array.from(m.entries()).map(([key, text]) => ({ key, text })) : [];
}

export function removeInstruction(sessionId: string, key: string): void {
  if (db) db.prepare("DELETE FROM instructions WHERE sessionId=? AND key=?").run(sessionId, key);
  else memInstructions.get(sessionId)?.delete(key);
}

// ---- usage / token accounting ----

export type UsageRow = { model: string; tokens: number; sessionId: string; ts: string };

export function recordUsage(sessionId: string, model: string, tokens: number): void {
  if (db) db.prepare("INSERT INTO usage (sessionId,model,tokens,ts) VALUES (?,?,?,?)").run(sessionId, model, tokens, new Date().toISOString());
  else memUsage.push({ sessionId, model, tokens, ts: new Date().toISOString() });
}

const memUsage: UsageRow[] = [];

export function usageSummary(sessionId?: string): { totalTokens: number; byModel: Array<{ model: string; tokens: number }> } {
  const rows = db
    ? (db.prepare(sessionId ? "SELECT model, SUM(tokens) as tokens FROM usage WHERE sessionId=? GROUP BY model" : "SELECT model, SUM(tokens) as tokens FROM usage GROUP BY model").all(...(sessionId ? [sessionId] : [])) as Array<{ model: string; tokens: number }>)
    : (() => {
        const filtered = sessionId ? memUsage.filter((u) => u.sessionId === sessionId) : memUsage;
        const m = new Map<string, number>();
        for (const u of filtered) m.set(u.model, (m.get(u.model) ?? 0) + u.tokens);
        return Array.from(m.entries()).map(([model, tokens]) => ({ model, tokens }));
      })();
  return { totalTokens: rows.reduce((a, r) => a + (r.tokens ?? 0), 0), byModel: rows };
}

// ---- profiles (user-level defaults; project config stays in .harness) ----

export type Profile = { id: string; name: string; settings: Record<string, unknown>; created: string };

const memProfiles: Profile[] = [];

export function listProfiles(): Profile[] {
  if (db) return (db.prepare("SELECT * FROM profiles").all() as Array<Profile & { settings: string }>).map((p) => ({ ...p, settings: JSON.parse(p.settings || "{}") as Record<string, unknown> }));
  return memProfiles;
}

export function upsertProfile(p: Profile): Profile {
  if (db) db.prepare("INSERT INTO profiles (id,name,settings,created) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, settings=excluded.settings").run(p.id, p.name, JSON.stringify(p.settings), p.created);
  else {
    const i = memProfiles.findIndex((x) => x.id === p.id);
    if (i >= 0) memProfiles[i] = p; else memProfiles.push(p);
  }
  return p;
}

export function getProfile(id: string): Profile | null {
  return listProfiles().find((p) => p.id === id) ?? null;
}

export function deleteProfile(id: string): boolean {
  const existed = getProfile(id) !== null;
  if (db) db.prepare("DELETE FROM profiles WHERE id=?").run(id);
  else {
    const i = memProfiles.findIndex((x) => x.id === id);
    if (i >= 0) memProfiles.splice(i, 1);
  }
  return existed;
}

// ---- session lifecycle helpers ----

export function touchSession(id: string): void {
  if (db) db.prepare("UPDATE sessions SET lastActivity=? WHERE id=?").run(new Date().toISOString(), id);
}

export function renameSession(id: string, title: string): void {
  if (db) db.prepare("UPDATE sessions SET title=? WHERE id=?").run(title, id);
  else { const s = memSessions.find((x) => x.id === id); if (s) s.title = title; }
}

export function deleteSession(id: string): void {
  if (db) {
    // Transaction: a crash mid-delete must not leave a half-removed session.
    db.transaction(() => {
      db.prepare("DELETE FROM messages WHERE sessionId=?").run(id);
      db.prepare("DELETE FROM instructions WHERE sessionId=?").run(id);
      db.prepare("DELETE FROM todos WHERE sessionId=?").run(id);
      db.prepare("DELETE FROM checkpoints WHERE sessionId=?").run(id);
      db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    })();
  } else {
    memMessages.delete(id);
    memInstructions.delete(id);
    memCheckpoints.delete(id);
    memSessions = memSessions.filter((s) => s.id !== id);
  }
}

export type SessionMeta = Session & { messageCount: number; lastActivity: string | null };

export function listSessionsWithMeta(): SessionMeta[] {
  if (db) {
    return (db.prepare(
      "SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.sessionId = s.id) as messageCount FROM sessions s ORDER BY COALESCE(s.lastActivity, s.created) DESC"
    ).all() as Array<SessionMeta>).map((s) => ({ ...s, lastActivity: s.lastActivity ?? null }));
  }
  return memSessions.map((s) => ({ ...s, messageCount: memMessages.get(s.id)?.length ?? 0, lastActivity: null }));
}

// ---- conversation history (multi-turn + compaction) ----
// Protocol-faithful persistence (external audit Finding A): tool_calls,
// tool_call_id, and name are stored alongside role/content so a reloaded
// conversation replays as valid OpenAI protocol - orphaned tool responses
// without their assistant tool-call records get rejected by some providers.

export type StoredMessage = {
  role: string;
  content: string;
  // JSON string of the assistant's tool_calls array (verbatim protocol form).
  toolCalls?: string;
  // Tool-result protocol metadata (role === "tool").
  toolCallId?: string;
  toolName?: string;
};

const memMessages = new Map<string, StoredMessage[]>();

export function saveMessages(sessionId: string, msgs: StoredMessage[]): void {
  if (db) {
    // Transaction: DELETE + N INSERTs are atomic, so a crash or a concurrent
    // process (serve + packaged app share this file) cannot leave partial turns.
    db.transaction(() => {
      db.prepare("DELETE FROM messages WHERE sessionId=?").run(sessionId);
      const ins = db.prepare("INSERT INTO messages (id,sessionId,seq,role,content,ts,toolCalls,toolCallId,toolName) VALUES (?,?,?,?,?,?,?,?,?)");
      const now = new Date().toISOString();
      msgs.forEach((m, i) => ins.run(`m_${sessionId}_${i}`, sessionId, i, m.role, m.content, now, m.toolCalls ?? null, m.toolCallId ?? null, m.toolName ?? null));
    })(msgs);
  } else {
    memMessages.set(sessionId, msgs);
  }
}

export function loadMessages(sessionId: string): StoredMessage[] {
  if (db) return db.prepare("SELECT role, content, toolCalls, toolCallId, toolName FROM messages WHERE sessionId=? ORDER BY seq").all(sessionId) as StoredMessage[];
  return memMessages.get(sessionId) ?? [];
}

export function messageCount(sessionId: string): number {
  if (db) return (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE sessionId=?").get(sessionId) as { n: number }).n;
  return (memMessages.get(sessionId) ?? []).length;
}

// ---- checkpoints (per-turn snapshots for fork/revert) ----

export type Checkpoint = { sessionId: string; seq: number; label: string; ts: string };
const memCheckpoints = new Map<string, Checkpoint[]>();

export function addCheckpoint(sessionId: string, seq: number, label: string): Checkpoint {
  const cp: Checkpoint = { sessionId, seq, label: label.slice(0, 80), ts: new Date().toISOString() };
  if (db) db.prepare("INSERT INTO checkpoints (sessionId,seq,label,ts) VALUES (?,?,?,?)").run(cp.sessionId, cp.seq, cp.label, cp.ts);
  else {
    if (!memCheckpoints.has(sessionId)) memCheckpoints.set(sessionId, []);
    memCheckpoints.get(sessionId)!.push(cp);
  }
  return cp;
}

export function listCheckpoints(sessionId: string): Checkpoint[] {
  if (db) return db.prepare("SELECT sessionId, seq, label, ts FROM checkpoints WHERE sessionId=? ORDER BY ts").all(sessionId) as Checkpoint[];
  return memCheckpoints.get(sessionId) ?? [];
}

// ---- fork (branch a session, optionally truncated at a checkpoint) ----

// Millisecond timestamps alone collide (two forks in the same ms = UNIQUE
// violation), so ids carry a random suffix.
export function newSessionId(): string {
  return `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
// ---- durable agent runs (Phase 1: the run is a first-class entity) ----
//
// Session = conversation; Run = work being performed. A run survives window
// close, restart, and model switch: state + append-only event timeline live in
// SQLite (roadmap Phase 1). SOP runs (in-memory) migrate onto this later.

export type AgentRunState =
  | "queued" | "planning" | "running" | "awaiting_approval" | "checkpointed"
  | "verifying" | "completed" | "needs_repair" | "failed" | "cancelled" | "interrupted";

export type AgentRun = {
  id: string;
  sessionId: string;
  objective: string;
  workdir: string;
  state: AgentRunState;
  lane?: string | null;
  model?: string | null;
  started: string;
  updated: string;
  ended?: string | null;
  error?: string | null;
  result?: string | null;
};

export type AgentRunEvent = { runId: string; seq: number; ts: string; kind: string; detail: string };

const memRuns = new Map<string, AgentRun>();
const memRunEvents = new Map<string, AgentRunEvent[]>();

const runRow = (r: any): AgentRun => ({
  id: r.id, sessionId: r.sessionId, objective: r.objective, workdir: r.workdir,
  state: r.state, lane: r.lane, model: r.model, started: r.started, updated: r.updated,
  ended: r.ended, error: r.error, result: r.result,
});

export function createAgentRun(run: AgentRun): AgentRun {
  if (db) db.prepare("INSERT INTO runs (id,sessionId,objective,workdir,state,lane,model,started,updated) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(run.id, run.sessionId, run.objective, run.workdir, run.state, run.lane ?? null, run.model ?? null, run.started, run.updated);
  else memRuns.set(run.id, { ...run });
  return run;
}

export function getAgentRun(id: string): AgentRun | null {
  if (db) {
    const r = db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    return r ? runRow(r) : null;
  }
  return memRuns.get(id) ?? null;
}

export function listAgentRuns(sessionId?: string): AgentRun[] {
  if (db) {
    const rows = sessionId
      ? db.prepare("SELECT * FROM runs WHERE sessionId=? ORDER BY started DESC LIMIT 200").all(sessionId)
      : db.prepare("SELECT * FROM runs ORDER BY started DESC LIMIT 200").all();
    return rows.map(runRow);
  }
  const all = Array.from(memRuns.values()).sort((a, b) => b.started.localeCompare(a.started));
  return sessionId ? all.filter((r) => r.sessionId === sessionId).slice(0, 200) : all.slice(0, 200);
}

export function updateAgentRun(id: string, patch: Partial<Pick<AgentRun, "state" | "lane" | "model" | "ended" | "error" | "result">>): void {
  const cur = getAgentRun(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updated: new Date().toISOString() };
  if (db) db.prepare("UPDATE runs SET state=?, lane=?, model=?, updated=?, ended=?, error=?, result=? WHERE id=?")
    .run(next.state, next.lane ?? null, next.model ?? null, next.updated, next.ended ?? null, next.error ?? null, next.result ?? null, id);
  else memRuns.set(id, next);
}

export function appendRunEvent(runId: string, kind: string, detail: string): AgentRunEvent {
  const ts = new Date().toISOString();
  if (db) {
    const seq = (db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS s FROM run_events WHERE runId=?").get(runId) as { s: number }).s;
    const ev: AgentRunEvent = { runId, seq, ts, kind, detail: detail.slice(0, 1000) };
    db.prepare("INSERT INTO run_events (runId,seq,ts,kind,detail) VALUES (?,?,?,?,?)").run(ev.runId, ev.seq, ev.ts, ev.kind, ev.detail);
    return ev;
  }
  const arr = memRunEvents.get(runId) ?? [];
  const ev: AgentRunEvent = { runId, seq: arr.length + 1, ts, kind, detail: detail.slice(0, 1000) };
  arr.push(ev);
  memRunEvents.set(runId, arr);
  return ev;
}

export function listRunEvents(runId: string): AgentRunEvent[] {
  if (db) return db.prepare("SELECT runId, seq, ts, kind, detail FROM run_events WHERE runId=? ORDER BY seq").all(runId) as AgentRunEvent[];
  return memRunEvents.get(runId) ?? [];
}

// Boot recovery: a run found mid-flight after a restart was interrupted - the
// conversation survived (messages persist) but the work stopped. Marked
// `interrupted` with an event; resumable by a later phase. Returns the runs
// that were flipped.
export function markStaleRunsInterrupted(): AgentRun[] {
  const active = listAgentRuns().filter((r) => r.state === "running" || r.state === "awaiting_approval" || r.state === "checkpointed" || r.state === "planning" || r.state === "queued");
  for (const r of active) {
    updateAgentRun(r.id, { state: "interrupted", ended: new Date().toISOString(), error: "interrupted by runtime restart" });
    appendRunEvent(r.id, "run.interrupted", "runtime restarted while the run was active");
  }
  return active;
}

// Test hook: close the handle so a re-initStore proves SQLite durability
// in-process (a fresh read of what was written before the "restart").
export function closeStore(): void {
  try { db?.close(); } catch { /* already closed */ }
  db = null;
}

// ---- fork (branch a session, optionally truncated at a checkpoint) ----

// Powers parallel windows: fork the session, pop a second chat window, try the
// other approach - the original is untouched.

export function forkSession(fromId: string, opts?: { title?: string; atSeq?: number }): Session | null {
  const src = listSessionsWithMeta().find((s) => s.id === fromId);
  if (!src) return null;
  const id = newSessionId();
  const session: Session = { id, title: opts?.title ?? `${src.title} (fork)`, worktree: src.worktree, created: new Date().toISOString() };
  const at = opts?.atSeq;
  if (db) {
    // Transaction: the fork is one logical unit (session row + message copy +
    // instructions) - a crash must not leave a fork skeleton behind.
    db.transaction(() => {
      db.prepare("INSERT INTO sessions (id,title,worktree,created) VALUES (?,?,?,?)").run(id, session.title, session.worktree, session.created);
      const now = new Date().toISOString();
      // Fork message ids embed the NEW session id: two forks of the same
      // parent previously collided on 'fk_<seq>' (UNIQUE constraint on
      // messages.id) and the second fork failed outright. Tool-call protocol
      // columns ride along so forks replay as valid conversations.
      if (at === undefined) {
        db.prepare("INSERT INTO messages (id,sessionId,seq,role,content,ts,toolCalls,toolCallId,toolName) SELECT 'fk_'||?||'_'||seq, ?, seq, role, content, ?, toolCalls, toolCallId, toolName FROM messages WHERE sessionId=? ORDER BY seq").run(id, id, now, fromId);
      } else {
        db.prepare("INSERT INTO messages (id,sessionId,seq,role,content,ts,toolCalls,toolCallId,toolName) SELECT 'fk_'||?||'_'||seq, ?, seq, role, content, ?, toolCalls, toolCallId, toolName FROM messages WHERE sessionId=? AND seq < ? ORDER BY seq").run(id, id, now, fromId, at);
      }
      db.prepare("INSERT INTO instructions (sessionId,key,text,ts) SELECT ?, key, text, ? FROM instructions WHERE sessionId=?").run(id, now, fromId);
    })();
  } else {
    memSessions = [...memSessions, session];
    const srcMsgs = memMessages.get(fromId) ?? [];
    memMessages.set(id, (at === undefined ? srcMsgs : srcMsgs.slice(0, at)).map((m) => ({ ...m })));
    const srcInstr = memInstructions.get(fromId);
    if (srcInstr) memInstructions.set(id, new Map(srcInstr));
  }
  return session;
}
