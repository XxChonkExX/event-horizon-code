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
      "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, sessionId TEXT, seq INTEGER, role TEXT, content TEXT, ts TEXT);" +
      "CREATE TABLE IF NOT EXISTS instructions (sessionId TEXT, key TEXT, text TEXT, ts TEXT, PRIMARY KEY (sessionId, key));" +
      "CREATE TABLE IF NOT EXISTS usage (sessionId TEXT, model TEXT, tokens INTEGER, ts TEXT);" +
      "CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT, settings TEXT, created TEXT);"
    );
    // Migration: older DBs predate the lastActivity column.
    try { db.exec("ALTER TABLE sessions ADD COLUMN lastActivity TEXT"); } catch { /* already present */ }
    return { mode: "sqlite" };
  } catch {
    db = null;
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
    db.prepare("DELETE FROM messages WHERE sessionId=?").run(id);
    db.prepare("DELETE FROM instructions WHERE sessionId=?").run(id);
    db.prepare("DELETE FROM todos WHERE sessionId=?").run(id);
    db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  } else {
    memMessages.delete(id);
    memInstructions.delete(id);
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
// Content-only persistence: tool_calls are not stored; continuity of
// user/assistant turns is what matters across turns.

type StoredMessage = { role: string; content: string };

const memMessages = new Map<string, StoredMessage[]>();

export function saveMessages(sessionId: string, msgs: StoredMessage[]): void {
  if (db) {
    db.prepare("DELETE FROM messages WHERE sessionId=?").run(sessionId);
    const ins = db.prepare("INSERT INTO messages (id,sessionId,seq,role,content,ts) VALUES (?,?,?,?,?,?)");
    msgs.forEach((m, i) => ins.run(`m_${sessionId}_${i}`, sessionId, i, m.role, m.content, new Date().toISOString()));
  } else {
    memMessages.set(sessionId, msgs);
  }
}

export function loadMessages(sessionId: string): StoredMessage[] {
  if (db) return db.prepare("SELECT role, content FROM messages WHERE sessionId=? ORDER BY seq").all(sessionId) as StoredMessage[];
  return memMessages.get(sessionId) ?? [];
}
