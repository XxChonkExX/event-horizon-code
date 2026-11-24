// Event Horizon Code — BYOK secrets (OS-keychain-backed at rest)
//
// `.harness/secrets.json` holds bring-your-own-key credentials:
//   { "openai": { "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-..." } }
// A secret value may instead be an OS-encrypted blob:
//   "apiKey": "enc1:<base64 of Electron safeStorage ciphertext>"
// encrypted through Electron's built-in safeStorage, i.e. the OS keychain
// (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). The
// ciphertext is bound to the OS user account: copying the file to another
// machine or user does not reveal the key.
//
// Rules (docs/ENCRYPTION.md, phase E1):
// - Encryption is AVAILABLE only where the OS keychain is reachable - the
//   desktop app's main process, where the runtime also lives. A headless
//   `npm run serve` cannot decrypt or encrypt: it says so and refuses. Never
//   a silent fallback, never plaintext written behind the operator's back.
// - Linux "plain text encryption" (a hard-coded key) is deliberately NOT
//   enabled: it would be obfuscation sold as security.
// - Nothing here ever returns a secret through the status API, and nothing is
//   logged except provider names and storage state.
// - Agent tools cannot read or write this file at all (credential denylist).

import fs from "node:fs";
import path from "node:path";

export type SecretRecord = { baseUrl?: string; apiKey?: string; [k: string]: unknown };
export type SecretValue = { baseUrl?: string; apiKey?: string };

const ENC_PREFIX = "enc1:";
// Field names whose values are secret; everything else (baseUrl) stays
// readable so the status view and lint tooling can show it.
const SECRET_FIELD = /key|token|secret|password/i;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_FILE_BYTES = 64 * 1024;

type SafeStorageLike = {
  encryptString(value: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isEncryptionAvailable?: () => boolean;
};

export class SecretError extends Error {
  constructor(public readonly code: "keychain-unavailable" | "undecryptable" | "invalid", message: string) {
    super(message);
    this.name = "SecretError";
  }
}

export function secretsPath(): string {
  // An empty override means "not set": an empty path would turn every read
  // into "no secret" and every write into a confusing error.
  return process.env.EH_SECRETS_FILE?.trim() || path.join(process.cwd(), ".harness", "secrets.json");
}

// The keychain, or null. Under ELECTRON_RUN_AS_NODE (headless serve) and
// plain node, require("electron") resolves to the executable PATH (a string),
// not the API surface - so the same guard covers both.
function safeStorage(): SafeStorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron") as unknown;
    if (!electron || typeof electron !== "object") return null;
    const ss = (electron as { safeStorage?: SafeStorageLike }).safeStorage;
    if (!ss || typeof ss.encryptString !== "function" || typeof ss.decryptString !== "function") return null;
    if (typeof ss.isEncryptionAvailable === "function" && !ss.isEncryptionAvailable()) return null;
    return ss;
  } catch { return null; }
}

export function encryptionAvailable(): boolean {
  return safeStorage() !== null;
}

export function isEncryptedValue(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(ENC_PREFIX);
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
    // Causes seen: sealed under another OS user/machine; damaged file; or the
    // profile's wrapping key never reached disk (a crash within ~10 s of the
    // very first launch on a new profile - docs/ENCRYPTION.md). The agent loop
    // keeps only the first 240 characters of a model error: stay under it.
    throw new SecretError(
      "undecryptable",
      "this secret could not be decrypted - sealed for another OS user or machine, a damaged file, or the app's key never reached disk (a crash within seconds of the first launch on a new profile); remove it and enter the key again",
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
    if (e instanceof SecretError) throw e;
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, SecretRecord>) : {};
  } catch { return {}; }
}

// Atomic replace + owner-only permissions where the OS supports them: a crash
// mid-write must not leave a half-written credentials file.
function saveRaw(all: Record<string, SecretRecord>): void {
  const p = secretsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows: mode is advisory */ }
  fs.renameSync(tmp, p);
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
  if (typeof rec.apiKey === "string" && rec.apiKey) {
    out.apiKey = isEncryptedValue(rec.apiKey) ? decryptValue(rec.apiKey) : rec.apiKey;
  }
  return out;
}

export function writeSecret(provider: string, value: SecretValue): { ok: true; encrypted: boolean } | { ok: false; error: string } {
  if (!validProviderId(provider)) return { ok: false, error: "provider id: letters, digits, - and _ only (1-32 chars)" };
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || value.apiKey.length === 0 || value.apiKey.length > 4096)) {
    return { ok: false, error: "apiKey must be 1-4096 characters" };
  }
  if (value.baseUrl !== undefined && (typeof value.baseUrl !== "string" || value.baseUrl.length > 2048 || (value.baseUrl !== "" && !/^https?:\/\//i.test(value.baseUrl)))) {
    return { ok: false, error: "baseUrl must be an http(s) URL" };
  }
  try {
    const all = loadRaw();
    const existing = all[provider] && typeof all[provider] === "object" ? all[provider] : {};
    const next: SecretRecord = { ...existing };
    if (value.baseUrl !== undefined) {
      if (value.baseUrl === "") delete next.baseUrl; else next.baseUrl = value.baseUrl;
    }
    if (value.apiKey !== undefined) {
      const available = encryptionAvailable();
      next.apiKey = available ? encryptValue(value.apiKey) : value.apiKey;
      all[provider] = next;
      saveRaw(all);
      return { ok: true, encrypted: available };
    }
    all[provider] = next;
    saveRaw(all);
    return { ok: true, encrypted: isEncryptedValue(next.apiKey) };
  } catch (e) {
    return { ok: false, error: e instanceof SecretError ? e.message : `could not write secrets: ${String((e as Error).message ?? e).slice(0, 120)}` };
  }
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

// Encrypt every plaintext secret value in place (the "lock what is already
// here" action). Refuses when the keychain is unreachable.
export function encryptAllSecrets(): { ok: boolean; encrypted: number; already: number; error?: string } {
  if (!encryptionAvailable()) {
    return { ok: false, encrypted: 0, already: 0, error: "OS keychain encryption is not available in this process - run the desktop app to encrypt stored keys" };
  }
  try {
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
    return { ok: true, encrypted, already };
  } catch (e) {
    return { ok: false, encrypted: 0, already: 0, error: e instanceof SecretError ? e.message : `could not encrypt: ${String((e as Error).message ?? e).slice(0, 120)}` };
  }
}

// Status for the UI. NEVER contains a secret value.
export function secretsStatus(): {
  path: string;
  encryptionAvailable: boolean;
  storage: "os-keychain" | "plaintext-only";
  headlessNote: string | null;
  providers: Array<{ provider: string; hasKey: boolean; encrypted: boolean; decryptable: boolean | null; hasBaseUrl: boolean }>;
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
    }];
  });
  return {
    path: secretsPath(),
    encryptionAvailable: available,
    storage: available ? "os-keychain" : "plaintext-only",
    headlessNote: available ? null : "OS keychain encryption needs the desktop app - this runtime runs headless and can only read plaintext keys",
    providers,
  };
}
