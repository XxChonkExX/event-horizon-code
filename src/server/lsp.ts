// Event Horizon Code - LSP/DAP manager
// Reads languages/<id>/language.json, spawns lazily per worktree, max 6 per worktree.
// No bundled runtimes. No auto-install. stdlib only (fs, child_process, url).
//
// Speaks LSP 3.17 over stdio with Content-Length framing: initialize handshake,
// didOpen/didChange/didClose, publishDiagnostics forwarding, hover and definition.
// A missing server binary is stated plainly - never silently ignored.

import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { audit } from "./audit";

// Local JS language servers (e.g. typescript-language-server) are devDependencies:
// resolve the package's JS entry and run it with node — under Electron the main
// process's node is electron itself, so set ELECTRON_RUN_AS_NODE. Falls back to
// PATH (with node_modules/.bin prepended) for globally installed tools.
function resolveLspCommand(cmd: string, args: string[]): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const localJs = ["lib/cli.mjs", "lib/cli.js", "dist/cli.mjs", "dist/cli.js", "bin/cli.js"]
    .map((p) => path.join(process.cwd(), "node_modules", cmd, p))
    .find((p) => fs.existsSync(p));
  if (localJs) {
    const isElectron = !!process.versions.electron;
    const env = { ...process.env };
    if (isElectron) env.ELECTRON_RUN_AS_NODE = "1";
    return { file: process.execPath, args: [localJs, ...args], env };
  }
  const binDir = path.join(process.cwd(), "node_modules", ".bin");
  return { file: cmd, args, env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` } };
}

export type LanguagePack = {
  id: string;
  displayName: string;
  tier: number;
  fileExtensions: string[];
  toolchain: { check: string[]; managers?: string[] };
  lsp: { command: string[] };
  dap: { command: string[] };
  formatter: { command: string[] };
  linter: { command: string[] };
  commands: { build: string; test: string; run: string };
  treeSitter: { grammar: string };
  engramPack: string;
  skill: string;
};

function languagesRoot(): string {
  // languages/ lives at repo root; in packaged app it is in resources/
  const candidates = [
    path.join(process.cwd(), "languages"),
    path.join(path.dirname(process.execPath), "resources", "languages"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return path.join(process.cwd(), "languages");
}

export function loadLanguagePacks(): LanguagePack[] {
  const root = languagesRoot();
  if (!fs.existsSync(root)) return [];
  const packs: LanguagePack[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "language.json");
    if (!fs.existsSync(file)) continue;
    try {
      packs.push(JSON.parse(fs.readFileSync(file, "utf8")) as LanguagePack);
    } catch {
      // Ignore malformed pack; Toolchain Doctor will flag it
    }
  }
  return packs.sort((a, b) => a.tier - b.tier || a.displayName.localeCompare(b.displayName));
}

export function resolveLanguageForFile(filePath: string, packs: LanguagePack[]): LanguagePack | null {
  const ext = path.extname(filePath).toLowerCase();
  return packs.find((p) => p.fileExtensions.includes(ext)) ?? null;
}

// ---- JSON-RPC 2.0 over stdio (Content-Length framing) ----
//
// LSP frames look like: "Content-Length: 42\r\n\r\n{...}". Some servers also
// emit bare \n\n separators; both are accepted. Requests we receive from the
// server (configuration, registerCapability, progress) get a minimal reply so
// the handshake never stalls on a client that ignores them.

type PendingRequest = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class LspConnection {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private proc: ChildProcess,
    private onNotification: (method: string, params: unknown) => void,
    private onServerRequest: (method: string, params: Record<string, unknown>) => unknown,
  ) {
    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.on("exit", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("language server exited"));
      }
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      // Find the end of the header block (\r\n\r\n per spec, \n\n tolerated).
      let sep = this.buffer.indexOf("\r\n\r\n");
      let sepLen = 4;
      if (sep < 0) { sep = this.buffer.indexOf("\n\n"); sepLen = 2; }
      if (sep < 0) return;
      const headers = this.buffer.subarray(0, sep).toString("utf8");
      let length = -1;
      for (const line of headers.split(/\r?\n/)) {
        const m = /^content-length\s*:\s*(\d+)\s*$/i.exec(line);
        if (m) length = Number(m[1]);
      }
      const start = sep + sepLen;
      if (length < 0) { this.buffer = this.buffer.subarray(start); continue; } // skip malformed header block
      if (this.buffer.length < start + length) return; // wait for the rest of the body
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      this.dispatch(body);
    }
  }

  private dispatch(body: string): void {
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: string } };
    try { msg = JSON.parse(body); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    // Server -> client request: answer so the server is not left waiting.
    if (msg.id !== undefined && typeof msg.method === "string") {
      const result = this.onServerRequest(msg.method, (msg.params ?? {}) as Record<string, unknown>);
      this.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: result === undefined ? null : result }));
      return;
    }
    // Response to one of our requests.
    if (msg.id !== undefined) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(Number(msg.id));
      if (msg.error) p.reject(new Error(msg.error.message ?? "lsp error"));
      else p.resolve(msg.result);
      return;
    }
    // Notification.
    if (typeof msg.method === "string") this.onNotification(msg.method, msg.params ?? {});
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("language server connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`lsp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }));
  }

  private send(s: string): void {
    const body = Buffer.from(s, "utf8");
    try {
      this.proc.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
      this.proc.stdin?.write(body);
    } catch { /* server died mid-write; the exit handler cleans up */ }
  }
}

type ServerEntry = {
  proc: ChildProcess;
  conn: LspConnection;
  lang: string;
  worktree: string;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
  rootUri: string;
  initPromise: Promise<void> | null;
  initialized: boolean;
  spawnError: string | null;
  docs: Map<string, number>; // file uri -> version
};

const MAX_PER_WORKTREE = 6;
const IDLE_EXIT_MS = 5 * 60 * 1000;

export type OpenResult = { ok: boolean; lang?: string; spawned?: boolean; error?: string };

export class LspManager {
  private servers = new Map<string, Map<string, ServerEntry>>(); // worktree -> lang -> entry
  private packsCache: LanguagePack[] | null = null;
  private lastDiagnostics = new Map<string, { uri: string; diagnostics: unknown[]; lang: string }>(); // diagKey -> latest
  private diagWaiters: Array<{ key: string; resolve: (d: unknown[]) => void }> = [];

  // Diagnostics map key. The server's pushed URI and our pathToFileURL form do
  // not agree on Windows: typescript-language-server sends
  // "file:///c%3A/Users/..." (lowercase drive, encoded colon) while we compute
  // "file:///C:/Users/...". Keying by raw URI made every Windows lookup miss -
  // hover/definition (request/response) worked while diagnostics (push-based)
  // were silently dead. Key by resolved native path instead; Linux forms
  // already agree, so normalization is a no-op there.
  private diagKey(uriOrPath: string): string {
    const p = uriOrPath.startsWith("file:") ? (safeUriToPath(uriOrPath) ?? uriOrPath) : uriOrPath;
    try {
      const abs = path.resolve(p);
      return process.platform === "win32" ? abs.toLowerCase() : abs;
    } catch { return uriOrPath; }
  }

  constructor(private packsOverride?: LanguagePack[]) {}

  // Multiplex diagnostics to all windows via callback (wired to SSE in index.ts)
  onDiagnostics: (worktree: string, lang: string, payload: unknown) => void = () => {};

  private languagePacks(): LanguagePack[] {
    if (this.packsOverride) return this.packsOverride;
    if (!this.packsCache) this.packsCache = loadLanguagePacks();
    return this.packsCache;
  }

  // ---- document lifecycle ----

  async openDocument(worktree: string, filePath: string, text: string, version = 1): Promise<OpenResult> {
    const pack = resolveLanguageForFile(filePath, this.languagePacks());
    if (!pack) return { ok: false, error: `no language pack covers ${path.extname(filePath) || "(no extension)"}` };
    const abs = path.resolve(worktree, filePath);
    if (!fs.existsSync(abs)) return { ok: false, error: `file not found: ${filePath}` };
    let entry: ServerEntry;
    try {
      entry = await this.ensureServer(worktree, pack);
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
    }
    if (entry.spawnError) return { ok: false, error: `language server "${pack.lsp.command[0]}" could not start: ${entry.spawnError}` };
    const uri = pathToFileURL(abs).toString();
    const existing = entry.docs.get(uri);
    if (existing !== undefined) {
      // Already open - an open of a known document is a change.
      return this.changeDocument(worktree, filePath, text, Math.max(version, existing + 1));
    }
    entry.docs.set(uri, version);
    entry.conn.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: pack.id, version, text },
    });
    this.bumpTimer(worktree, pack.id, entry);
    return { ok: true, lang: pack.id, spawned: entry.docs.size === 1 };
  }

  async changeDocument(worktree: string, filePath: string, text: string, version?: number): Promise<OpenResult> {
    const pack = resolveLanguageForFile(filePath, this.languagePacks());
    if (!pack) return { ok: false, error: `no language pack covers ${path.extname(filePath) || "(no extension)"}` };
    const entry = this.servers.get(worktree)?.get(pack.id);
    if (!entry) return { ok: false, error: `${filePath} is not open in the ${pack.id} language server` };
    const abs = path.resolve(worktree, filePath);
    const uri = pathToFileURL(abs).toString();
    const v = version ?? (entry.docs.get(uri) ?? 0) + 1;
    entry.docs.set(uri, v);
    entry.conn.notify("textDocument/didChange", {
      textDocument: { uri, version: v },
      contentChanges: [{ text }], // full sync - simplest and universally supported
    });
    this.bumpTimer(worktree, pack.id, entry);
    return { ok: true, lang: pack.id };
  }

  async closeDocument(worktree: string, filePath: string): Promise<OpenResult> {
    const pack = resolveLanguageForFile(filePath, this.languagePacks());
    if (!pack) return { ok: false, error: "no language pack for file" };
    const entry = this.servers.get(worktree)?.get(pack.id);
    if (!entry) return { ok: false, error: `${filePath} is not open` };
    const uri = pathToFileURL(path.resolve(worktree, filePath)).toString();
    if (!entry.docs.has(uri)) return { ok: false, error: `${filePath} is not open` };
    entry.docs.delete(uri);
    entry.conn.notify("textDocument/didClose", { textDocument: { uri } });
    return { ok: true, lang: pack.id };
  }

  // ---- language features the agent and editor can query ----

  async hover(worktree: string, filePath: string, line: number, character: number): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    return this.featureRequest(worktree, filePath, "textDocument/hover", line, character);
  }

  async definition(worktree: string, filePath: string, line: number, character: number): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    return this.featureRequest(worktree, filePath, "textDocument/definition", line, character);
  }

  private async featureRequest(worktree: string, filePath: string, method: string, line: number, character: number) {
    const pack = resolveLanguageForFile(filePath, this.languagePacks());
    if (!pack) return { ok: false, error: `no language pack covers ${path.extname(filePath) || "(no extension)"}` };
    const entry = this.servers.get(worktree)?.get(pack.id);
    if (!entry) return { ok: false, error: `${filePath} is not open - call lsp/open first` };
    try {
      const result = await entry.conn.request(method, {
        textDocument: { uri: pathToFileURL(path.resolve(worktree, filePath)).toString() },
        position: { line, character },
      }, 10_000);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
    }
  }

  // Diagnostics for a file: pull first (LSP 3.17 - servers like a future
  // typescript-language-server may implement textDocument/diagnostic), then
  // fall back to waiting for a push. If the server implements NEITHER (tls
  // v6.1.0 as shipped: capability declared, pull answered "Unhandled method",
  // push never fires), the empty result says so rather than hanging.
  async diagnosticsFor(worktree: string, filePath: string, timeoutMs = 4000): Promise<{ ok: boolean; diagnostics?: unknown[]; error?: string; note?: string }> {
    const pack = resolveLanguageForFile(filePath, this.languagePacks());
    if (!pack) return { ok: false, error: "no language pack for file" };
    const entry = this.servers.get(worktree)?.get(pack.id);
    if (!entry) return { ok: false, error: `${filePath} is not open` };
    const uri = pathToFileURL(path.resolve(worktree, filePath)).toString();
    const key = this.diagKey(uri);
    const have = this.lastDiagnostics.get(key);
    if (have) return { ok: true, diagnostics: have.diagnostics };
    // Pull (best effort): a MethodNotFound/unhandled reply lands here and we
    // fall through to the push waiter below.
    try {
      const report = await entry.conn.request("textDocument/diagnostic", { textDocument: { uri } }, Math.min(timeoutMs, 3000));
      const items = (report as { kind?: string; items?: unknown[] } | null)?.items;
      if (Array.isArray(items)) {
        this.lastDiagnostics.set(key, { uri, diagnostics: items, lang: pack.id });
        return { ok: true, diagnostics: items };
      }
    } catch { /* pull unsupported - push-based server */ }
    const got = await new Promise<unknown[]>((resolve) => {
      let done = false;
      this.diagWaiters.push({ key, resolve: (d) => { if (!done) { done = true; resolve(d); } } });
      setTimeout(() => { if (!done) { done = true; resolve(this.lastDiagnostics.get(key)?.diagnostics ?? []); } }, timeoutMs);
    });
    return { ok: true, diagnostics: got, ...(got.length === 0 ? { note: "server published no diagnostics within the wait window (hover/definition still work; this server may not implement diagnostics)" } : {}) };
  }

  // ---- server lifecycle ----

  private async ensureServer(worktree: string, pack: LanguagePack): Promise<ServerEntry> {
    let byLang = this.servers.get(worktree);
    if (!byLang) { byLang = new Map(); this.servers.set(worktree, byLang); }
    const existing = byLang.get(pack.id);
    if (existing) {
      existing.lastUsed = Date.now();
      this.bumpTimer(worktree, pack.id, existing);
      if (existing.initPromise) await existing.initPromise;
      return existing;
    }
    if (byLang.size >= MAX_PER_WORKTREE) {
      // Evict LRU
      const oldest = Array.from(byLang.values()).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      this.kill(worktree, oldest.lang);
    }
    const rootUri = pathToFileURL(worktree).toString();
    const [cmd, ...args] = pack.lsp.command;
    const resolved = resolveLspCommand(cmd, args);
    const proc = spawn(resolved.file, resolved.args, {
      cwd: worktree,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: resolved.env,
    });
    // A write landing after the child died emits an ASYNC EPIPE on stdin -
    // without a listener that is an uncaughtException fatal to the runtime
    // (the surrounding try/catch only catches synchronous throws).
    proc.stdin?.on("error", (err) => { try { audit({ tool: "lsp", note: `stdin error: ${String((err as Error).message ?? err).slice(0, 120)}` }); } catch { /* audit never blocks */ } });
    const entry: ServerEntry = {
      proc, conn: undefined as never, lang: pack.id, worktree, lastUsed: Date.now(),
      timer: undefined as never, rootUri, initPromise: null, initialized: false,
      spawnError: null, docs: new Map(),
    };
    entry.timer = setTimeout(() => this.kill(worktree, pack.id), IDLE_EXIT_MS);
    entry.conn = new LspConnection(
      proc,
      (method, params) => this.onServerMessage(entry, method, params),
      (method, params) => this.answerServerRequest(entry, method, params),
    );
    proc.on("error", (e) => { entry.spawnError = String(e.message ?? e); });
    proc.on("exit", () => {
      clearTimeout(entry.timer);
      byLang?.delete(pack.id);
      if (byLang && byLang.size === 0) this.servers.delete(worktree);
    });
    byLang.set(pack.id, entry);
    entry.initPromise = this.initialize(entry, pack).finally(() => { entry.initPromise = null; });
    await entry.initPromise;
    return entry;
  }

  private async initialize(entry: ServerEntry, pack: LanguagePack): Promise<void> {
    await entry.conn.request("initialize", {
      processId: process.pid,
      rootUri: entry.rootUri,
      rootPath: entry.worktree,
      workspaceFolders: [{ uri: entry.rootUri, name: path.basename(entry.worktree) }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          // Required for typescript-language-server >= 6: without the
          // publishDiagnostics capability it sets diagnosticsSupport=false and
          // silently drops every tsserver diag event - hover/definition worked
          // while diagnostics stayed empty forever (found by live probe:
          // no publishDiagnostics frame is ever sent, and
          // textDocument/diagnostic is "Unhandled method" - push-only server).
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true,
            tagSupport: { valueSet: [1, 2] }, // Unnecessary (1), Deprecated (2)
          },
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
    }, 20_000);
    entry.conn.notify("initialized", {});
    entry.initialized = true;
    void pack;
  }

  private onServerMessage(entry: ServerEntry, method: string, params: unknown): void {
    if (method === "textDocument/publishDiagnostics") {
      const p = params as { uri?: string; diagnostics?: unknown[] };
      const uri = p.uri ?? "";
      const diagnostics = Array.isArray(p.diagnostics) ? p.diagnostics : [];
      const key = this.diagKey(uri);
      this.lastDiagnostics.set(key, { uri, diagnostics, lang: entry.lang });
      // Flush anything waiting on diagnostics for this file.
      this.diagWaiters = this.diagWaiters.filter((w) => {
        if (w.key !== key) return true;
        w.resolve(diagnostics);
        return false;
      });
      this.onDiagnostics(entry.worktree, entry.lang, { uri, path: safeUriToPath(uri), diagnostics });
      return;
    }
    // Other notifications (window/logMessage, $/progress) are intentionally ignored.
  }

  private answerServerRequest(entry: ServerEntry, method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "workspace/configuration": {
        const items = Array.isArray(params.items) ? params.items : [];
        return items.map(() => null); // no user settings configured - let server defaults apply
      }
      case "workspace/workspaceFolders":
        return [{ uri: entry.rootUri, name: path.basename(entry.worktree) }];
      case "workspace/applyEdit":
        return { applied: false }; // edits are user-approved, never auto-applied
      default:
        return null; // registerCapability, workDoneProgress/create, showMessageRequest, ...
    }
  }

  status(): Array<{ worktree: string; lang: string; pid: number; openDocuments: number; lastUsed: string; initialized: boolean }> {
    const out: Array<{ worktree: string; lang: string; pid: number; openDocuments: number; lastUsed: string; initialized: boolean }> = [];
    for (const [worktree, byLang] of this.servers) {
      for (const entry of byLang.values()) {
        out.push({
          worktree, lang: entry.lang, pid: entry.proc.pid ?? 0,
          openDocuments: entry.docs.size,
          lastUsed: new Date(entry.lastUsed).toISOString(),
          initialized: entry.initialized,
        });
      }
    }
    return out;
  }

  private bumpTimer(worktree: string, lang: string, entry: ServerEntry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.kill(worktree, lang), IDLE_EXIT_MS);
  }

  kill(worktree: string, lang: string) {
    const byLang = this.servers.get(worktree);
    const entry = byLang?.get(lang);
    if (!entry) return;
    clearTimeout(entry.timer);
    byLang?.delete(lang);
    if (byLang && byLang.size === 0) this.servers.delete(worktree);
    // LSP shutdown sequence: ask politely, then force-exit. Bounded so a hung
    // server cannot outlive the manager by more than the request timeout.
    entry.conn.request("shutdown", null, 1000)
      .catch(() => { /* server already gone or hung */ })
      .finally(() => {
        try { entry.conn.notify("exit"); } catch { /* ignore */ }
        try { entry.proc.kill(); } catch { /* ignore */ }
      });
  }

  killWorktree(worktree: string) {
    const byLang = this.servers.get(worktree);
    if (!byLang) return;
    for (const lang of Array.from(byLang.keys())) this.kill(worktree, lang);
    this.servers.delete(worktree);
  }

  killAll(): void {
    for (const worktree of Array.from(this.servers.keys())) this.killWorktree(worktree);
  }

  // Synchronous last resort for process exit, where async shutdown cannot run.
  killAllSync(): void {
    for (const byLang of this.servers.values()) {
      for (const entry of byLang.values()) {
        clearTimeout(entry.timer);
        try { entry.proc.kill(); } catch { /* ignore */ }
      }
    }
    this.servers.clear();
  }
}

function safeUriToPath(uri: string): string | null {
  try { return fileURLToPath(uri); } catch { return null; }
}

// Never orphan language servers when the harness dies.
process.on("exit", () => { lspManager.killAllSync(); });

export const lspManager = new LspManager();
