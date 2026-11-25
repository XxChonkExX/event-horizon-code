// Event Horizon Code — BYOK secrets (OS-keychain-backed at rest)
//
// `.harness/secrets.json` holds bring-your-own-key credentials:
//   { "openai": { "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "model": "gpt-4o-mini" } }
// A secret value may instead be an OS-encrypted blob:
//   "apiKey": "enc1:<base64 of Electron safeStorage ciphertext>"
// encrypted through Electron's built-in safeStorage, i.e. the OS keychain
// (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). The
// ciphertext is bound to the OS user account: copying the file to another
// machine or user does not reveal the key. `baseUrl` and `model` stay readable.
//
// Rules (docs/ENCRYPTION.md, phase E1):
// - Encryption is AVAILABLE only where the OS keychain is reachable - the
//   desktop app's main process, where the runtime also lives. A headless
//   `npm run serve` cannot decrypt or encrypt: it says so and refuses. Never
//   a silent fallback, never plaintext written behind the operator's back.
// - Linux "plain text encryption" (a hard-coded key) is deliberately NOT
//   enabled: it would be obfuscation sold as security.
// - Nothing here ever returns a secret through an API, and nothing is logged
//   except provider names and storage state.
// - Agent tools cannot read or write this file at all (credential denylist).
// - No network call is made from this module.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SecretRecord = { baseUrl?: string; apiKey?: string; model?: string; [k: string]: unknown };
export type SecretValue = { baseUrl?: string; apiKey?: string; model?: string };
export type WriteResult = { ok: true; encrypted: boolean; settled: boolean } | { ok: false; error: string };
export type BackupInfo = { name: string; createdAt: string; bytes: number; providers: string[] };

const ENC_PREFIX = "enc1:";
// Field names whose values are secret; everything else (baseUrl, model) stays
// readable so the status view and lint tooling can show it.
const SECRET_FIELD = /key|token|secret|password/i;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_FILE_BYTES = 64 * 1024;

// A stored provider is selected from the composer's model picker as
// "byok:<provider>" (and by profiles the same way). An explicit `provider`
// request param keeps working for ACP clients.
export const BYOK_MODEL_PREFIX = "byok:";
export function byokModelId(provider: string): string { return BYOK_MODEL_PREFIX + provider; }
export function byokProviderFromModel(model: string | undefined | null): string | null {
  if (typeof model !== "string" || !model.startsWith(BYOK_MODEL_PREFIX)) return null;
  const id = model.slice(BYOK_MODEL_PREFIX.length);
  return PROVIDER_ID.test(id) ? id : null;
}

type SafeStorageLike = {
  encryptString(value: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isEncryptionAvailable?: () => boolean;
};
type ElectronLike = { safeStorage?: SafeStorageLike; app?: { getPath(name: string): string } };

export class SecretError extends Error {
  readonly code: "keychain-unavailable" | "undecryptable" | "invalid";
  constructor(code: "keychain-unavailable" | "undecryptable" | "invalid", message: string) {
    super(message);
    this.name = "SecretError";
    this.code = code;
  }
}

export function secretsPath(): string {
  // An empty override means "not set": an empty path would turn every read
  // into "no secret" and every write into a confusing error.
  return process.env.EH_SECRETS_FILE?.trim() || path.join(process.cwd(), ".harness", "secrets.json");
}

// Backups are PLAINTEXT copies of the secrets file, taken before existing keys
// are sealed (so the operator keeps a way back if a sealed key is ever lost).
// They live in the app's own per-user directory - never inside a workspace,
// where an agent or a git commit could reach them - and the file is called
// `secrets.json`, a name the agent shell rule already refuses.
export function backupsDir(): string {
  return process.env.EH_BACKUPS_DIR?.trim() || path.join(os.homedir(), ".eventhorizon", "backups");
}
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d+)?$/;

// The Electron API surface, or null. Under ELECTRON_RUN_AS_NODE (headless
// serve) and plain node, require("electron") resolves to the executable PATH
// (a string), not the API surface - so the same guard covers both.
function electronApi(): ElectronLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as unknown;
    if (!electron || typeof electron !== "object") return null;
    return electron as ElectronLike;
  } catch { return null; }
}

function safeStorage(): SafeStorageLike | null {
  const ss = electronApi()?.safeStorage;
  if (!ss || typeof ss.encryptString !== "function" || typeof ss.decryptString !== "function") return null;
  if (typeof ss.isEncryptionAvailable === "function" && !ss.isEncryptionAvailable()) return null;
  return ss;
}

export function encryptionAvailable(): boolean {
  return safeStorage() !== null;
}

export function isEncryptedValue(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(ENC_PREFIX);
}

// --- settle-before-seal -----------------------------------------------------
// The key that wraps safeStorage values is kept by Chromium. On Windows, a
// brand-new profile writes it to "<userData>/Local State" about 10 s after the
// first launch, or at once on a normal close - NOT when a value is sealed. A
// value sealed before that lands is lost if the app dies first (measured; see
// docs/ENCRYPTION.md). So the first seal on a fresh profile waits for the key
// to reach disk. macOS and Linux keep the key in the OS keyring itself.
const SETTLE_POLL_MS = 250;
const SETTLE_MAX_MS = 30_000;
type SettleState = "settled" | "unconfirmed" | "not-applicable";
let settleMemo: SettleState | null = null;

export function wrappingKeyOnDisk(): boolean | null {
  // null = nothing to check here (no Electron app API, or no userData path).
  const dir = electronApi()?.app?.getPath("userData");
  if (!dir) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "Local State"), "utf8")) as { os_crypt?: { encrypted_key?: unknown } };
    return typeof raw.os_crypt?.encrypted_key === "string" && raw.os_crypt.encrypted_key.length > 0;
  } catch {
    return false; // not written yet, or mid-write
  }
}

async function waitForWrappingKey(): Promise<SettleState> {
  if (settleMemo) return settleMemo;
  if (process.platform !== "win32") return (settleMemo = "not-applicable");
  const t0 = Date.now();
  for (;;) {
    const onDisk = wrappingKeyOnDisk();
    if (onDisk === true) return (settleMemo = "settled");
    if (onDisk === null) return (settleMemo = "not-applicable");
    // Unknown shape, or simply not written yet and we have waited long enough:
    // proceed as before and say the durability could not be confirmed.
    if (Date.now() - t0 > SETTLE_MAX_MS) return "unconfirmed";
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

// Sealing may now wait, so two saves can interleave: one read-modify-write at
// a time (in this process; the rename itself is atomic across processes).
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

function encryptValue(plain: string): string {
  const ss = safeStorage();
  if (!ss) throw new SecretError("keychain-unavailable", "OS keychain encryption is not available in this process - save secrets from the desktop app");
  return ENC_PREFIX + ss.encryptString(plain).toString("base64");
}

function decryptValue(blob: string): string {
  const ss = safeStorage();
  if (!ss) {
    throw new SecretError(
      "keychain-unavailable",
      "this secret is encrypted with the OS keychain, which a headless runtime cannot reach - run the desktop app, or keep a plaintext copy for headless use",
    );
  }
  try {
    return ss.decryptString(Buffer.from(blob.slice(ENC_PREFIX.length), "base64"));
  } catch {
    // Causes seen: sealed under another OS user/machine; damaged file; a
    // profile whose wrapping key never reached disk (docs/ENCRYPTION.md).
    // The agent loop keeps only the first 240 characters of a model error:
    // stay under it.
    throw new SecretError(
      "undecryptable",
      "this secret could not be decrypted - sealed for another OS user or machine, or a damaged file; restore it from your plaintext backup or enter the key again",
    );
  }
}

function loadRaw(): Record<string, SecretRecord> {
  let raw: string;
  try {
    const st = fs.statSync(secretsPath());
    if (st.size > MAX_FILE_BYTES) throw new Error("secrets file exceeds 64 KB");
    raw = fs.readFileSync(secretsPath(), "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return {};
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, SecretRecord>) : {};
  } catch { return {}; }
}

// Owner-only permissions where the OS supports them, flushed to disk, then an
// atomic rename: a crash mid-write must not leave a half-written credentials
// file, and a sealed value must be on disk when the save returns.
function writeFileDurable(p: string, data: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(p, "wx", 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try { fs.chmodSync(p, 0o600); } catch { /* Windows: mode is advisory */ }
}

function saveRaw(all: Record<string, SecretRecord>): void {
  const p = secretsPath();
  const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileDurable(tmp, JSON.stringify(all, null, 2) + "\n");
    fs.renameSync(tmp, p);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw e;
  }
}

export function validProviderId(id: unknown): id is string {
  return typeof id === "string" && PROVIDER_ID.test(id);
}

// Decrypted secret for a provider, or null when none is configured. Throws
// SecretError when a secret exists but cannot be decrypted here - the caller
// turns that into an honest failure instead of a "missing key" guess.
export function readSecret(provider: string): SecretValue | null {
  const rec = loadRaw()[provider];
  if (!rec || typeof rec !== "object") return null;
  const out: SecretValue = {};
  if (typeof rec.baseUrl === "string" && rec.baseUrl) out.baseUrl = rec.baseUrl;
  if (typeof rec.model === "string" && rec.model) out.model = rec.model;
  if (typeof rec.apiKey === "string" && rec.apiKey) {
    out.apiKey = isEncryptedValue(rec.apiKey) ? decryptValue(rec.apiKey) : rec.apiKey;
  }
  return out;
}

function validModel(m: unknown): boolean {
  return typeof m === "string" && m.length <= 200 && !/[\u0000-\u001f\u007f]/.test(m);
}

export function writeSecret(provider: string, value: SecretValue): Promise<WriteResult> {
  if (!validProviderId(provider)) return Promise.resolve({ ok: false, error: "provider id: letters, digits, - and _ only (1-32 chars)" });
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey.length === 0 || value.apiKey.length > 4096)) {
    return Promise.resolve({ ok: false, error: "apiKey must be 1-4096 characters" });
  }
  if (value.baseUrl !== undefined && (typeof value.baseUrl !== "string" || value.baseUrl.length > 2048 || (value.baseUrl !== "" && !/^https?:\/\//i.test(value.baseUrl)))) {
    return Promise.resolve({ ok: false, error: "baseUrl must be an http(s) URL" });
  }
  if (value.model !== undefined && !validModel(value.model)) {
    return Promise.resolve({ ok: false, error: "model must be at most 200 characters on one line" });
  }
  const seal = value.apiKey !== undefined && encryptionAvailable();
  return withWriteLock(async (): Promise<WriteResult> => {
    try {
      // Before the first seal on a fresh profile: wait for the wrapping key.
      const settled = seal ? (await waitForWrappingKey()) !== "unconfirmed" : true;
      // Read AFTER any wait, then merge: other fields and providers survive.
      const all = loadRaw();
      const existing = all[provider] && typeof all[provider] === "object" ? all[provider] : {};
      const next: SecretRecord = { ...existing };
      if (value.baseUrl !== undefined) {
        if (value.baseUrl === "") delete next.baseUrl; else next.baseUrl = value.baseUrl;
      }
      if (value.model !== undefined) {
        const m = value.model.trim();
        if (m === "") delete next.model; else next.model = m;
      }
      if (value.apiKey !== undefined) next.apiKey = seal ? encryptValue(value.apiKey) : value.apiKey;
      all[provider] = next;
      saveRaw(all);
      return { ok: true, encrypted: isEncryptedValue(next.apiKey), settled };
    } catch (e) {
      return { ok: false, error: e instanceof SecretError ? e.message : `could not write secrets: ${String((e as Error).message ?? e).slice(0, 120)}` };
    }
  });
}

export function deleteSecret(provider: string): { ok: boolean; error?: string } {
  if (!validProviderId(provider)) return { ok: false, error: "invalid provider id" };
  try {
    const all = loadRaw();
    if (!(provider in all)) return { ok: false, error: `no secret stored for "${provider}"` };
    delete all[provider];
    saveRaw(all);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not update secrets: ${String((e as Error).message ?? e).slice(0, 120)}` };
  }
}

// Seal every plaintext secret value in place (the "lock what is already
// here" action). Refuses when the keychain is unreachable.
export function encryptAllSecrets(): Promise<{ ok: boolean; encrypted: number; already: number; settled?: boolean; error?: string }> {
  if (!encryptionAvailable()) {
    return Promise.resolve({ ok: false, encrypted: 0, already: 0, error: "OS keychain encryption is not available in this process - run the desktop app to encrypt stored keys" });
  }
  return withWriteLock(async () => {
    try {
      const settled = (await waitForWrappingKey()) !== "unconfirmed";
      const all = loadRaw();
      let encrypted = 0;
      let already = 0;
      for (const rec of Object.values(all)) {
        if (!rec || typeof rec !== "object") continue;
        for (const [field, v] of Object.entries(rec)) {
          if (!SECRET_FIELD.test(field) || typeof v !== "string" || !v) continue;
          if (isEncryptedValue(v)) { already++; continue; }
          rec[field] = encryptValue(v);
          encrypted++;
        }
      }
      if (encrypted > 0) saveRaw(all);
      return { ok: true, encrypted, already, settled };
    } catch (e) {
      return { ok: false, encrypted: 0, already: 0, error: e instanceof SecretError ? e.message : `could not encrypt: ${String((e as Error).message ?? e).slice(0, 120)}` };
    }
  });
}

// --- plaintext backups ------------------------------------------------------

function backupProviders(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).sort() : [];
  } catch { return []; }
}

// Copy the secrets file exactly as it is - no decryption is involved, which
// is what makes this safe to call just before keys get sealed.
export function createBackup(): { ok: true; path: string; bytes: number } | { ok: false; error: string } {
  const src = secretsPath();
  try {
    const st = fs.statSync(src);
    if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) return { ok: false, error: "no secrets file to back up" };
    const dir = backupsDir();
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const base = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}_${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}`;
    let name = base;
    for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}`;
    const file = path.join(dir, name, "secrets.json");
    writeFileDurable(file, fs.readFileSync(src).toString("utf8"));
    return { ok: true, path: file, bytes: st.size };
  } catch (e) {
    return { ok: false, error: `could not write the backup: ${String((e as Error).message ?? e).slice(0, 120)}` };
  }
}

export function listBackups(): BackupInfo[] {
  const dir = backupsDir();
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => BACKUP_NAME.test(n))
    .flatMap((name) => {
      try {
        const file = path.join(dir, name, "secrets.json");
        const st = fs.statSync(file);
        if (!st.isFile()) return [];
        return [{ name, createdAt: st.mtime.toISOString(), bytes: st.size, providers: backupProviders(file) }];
      } catch { return []; }
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

// Name is validated against a strict pattern and can never contain a path
// separator: deletion is confined to the backups directory by construction.
export function deleteBackup(name: string): { ok: boolean; error?: string } {
  if (typeof name !== "string" || !BACKUP_NAME.test(name)) return { ok: false, error: "invalid backup name" };
  const target = path.join(backupsDir(), name);
  try {
    if (!fs.existsSync(target)) return { ok: false, error: "no such backup" };
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `could not delete the backup: ${String((e as Error).message ?? e).slice(0, 120)}` };
  }
}

// Providers offered to the composer's picker (and to profiles): a key, a base
// URL and a model that this runtime can actually read. A sealed key counts
// only when decrypting it was CONFIRMED here - on a runtime with no keychain
// it reports "cannot tell", and using it there can only fail.
export function usableByokProviders(): Array<{ provider: string; model: string | null }> {
  return secretsStatus().providers.flatMap((p) => (p.hasKey && p.hasBaseUrl && p.model && (!p.encrypted || p.decryptable === true) ? [{ provider: p.provider, model: p.model }] : []));
}

// Status for the UI and the model picker. NEVER contains a secret value.
export function secretsStatus(): {
  path: string;
  encryptionAvailable: boolean;
  storage: "os-keychain" | "plaintext-only";
  headlessNote: string | null;
  providers: Array<{ provider: string; hasKey: boolean; encrypted: boolean; decryptable: boolean | null; hasBaseUrl: boolean; baseUrl: string | null; model: string | null }>;
  backups: BackupInfo[];
} {
  const available = encryptionAvailable();
  const raw = loadRaw();
  const providers = Object.entries(raw).flatMap(([provider, rec]) => {
    if (!rec || typeof rec !== "object") return [];
    const key = rec.apiKey;
    const encrypted = isEncryptedValue(key);
    let decryptable: boolean | null = null;
    if (encrypted && available) {
      try { decryptValue(key); decryptable = true; } catch { decryptable = false; }
    }
    return [{
      provider,
      hasKey: typeof key === "string" && key.length > 0,
      encrypted,
      decryptable,
      hasBaseUrl: typeof rec.baseUrl === "string" && rec.baseUrl.length > 0,
      baseUrl: typeof rec.baseUrl === "string" && rec.baseUrl ? rec.baseUrl : null,
      model: typeof rec.model === "string" && rec.model ? rec.model : null,
    }];
  });
  return {
    path: secretsPath(),
    encryptionAvailable: available,
    storage: available ? "os-keychain" : "plaintext-only",
    headlessNote: available ? null : "OS keychain encryption needs the desktop app - this runtime runs headless and can only read plaintext keys",
    providers,
    backups: listBackups(),
  };
}
