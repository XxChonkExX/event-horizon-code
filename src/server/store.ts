// Event Horizon Code — Session store (SQLite WAL)
// Minimal: sessions + todos. better-sqlite3 is a declared dep but lazy-loaded
// so startup works without native build. In-memory fallback in dev.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export type Session = { id: string; title: string; worktree: string; created: string };
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
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, title TEXT, worktree TEXT, created TEXT);" +
      "CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, sessionId TEXT, text TEXT, done INTEGER);"
    );
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
