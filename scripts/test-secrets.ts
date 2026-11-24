// BYOK secrets tests - the paths that need NO keychain: plaintext storage,
// honest refusal when an encrypted blob cannot be decrypted here, input
// validation, status privacy, atomic writes. Run: npm run secrets:test
//
// The keychain path itself (encrypt -> disk -> decrypt under DPAPI/Keychain)
// is proven by `npm run secrets:test:electron`, which bundles the module and
// runs it inside real Electron. Never touches the operator's real secrets
// file: everything goes through EH_SECRETS_FILE.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readSecret, writeSecret, deleteSecret, encryptAllSecrets, secretsStatus,
  encryptionAvailable, isEncryptedValue, secretsPath, SecretError,
} from "../src/server/secrets";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-secrets-"));
const file = path.join(dir, "secrets.json");
process.env.EH_SECRETS_FILE = file;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log(`[ehc] secrets tests (keychain available: ${encryptionAvailable()})`);

  // 1. path override + absence is a plain null, never a throw
  check("path override honored", secretsPath() === file);
  // An empty or blank override is "not set", never an empty path.
  const defaultPath = path.join(process.cwd(), ".harness", "secrets.json");
  process.env.EH_SECRETS_FILE = "";
  check("an EMPTY override falls back to the default path", secretsPath() === defaultPath);
  process.env.EH_SECRETS_FILE = "   ";
  check("a whitespace-only override falls back to the default path", secretsPath() === defaultPath);
  process.env.EH_SECRETS_FILE = file;
  check("path override restored before any file access", secretsPath() === file);
  check("missing file reads as null", readSecret("openai") === null);

  // 2. plaintext roundtrip (what a headless runtime does)
  const w = writeSecret("openai", { baseUrl: "https://api.example.com/v1", apiKey: "sk-plaintext-test" });
  check("write succeeds", w.ok === true, JSON.stringify(w));
  check("write reports its storage state honestly", !w.ok || w.encrypted === encryptionAvailable(), JSON.stringify(w));
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { openai: { baseUrl: string; apiKey: string } };
  check("baseUrl stays readable on disk", onDisk.openai.baseUrl === "https://api.example.com/v1");
  check("key on disk is plaintext exactly when no keychain", isEncryptedValue(onDisk.openai.apiKey) === encryptionAvailable());
  const r = readSecret("openai");
  check("read roundtrips", r?.apiKey === "sk-plaintext-test" && r?.baseUrl === "https://api.example.com/v1");

  // 3. validation refuses before touching the file
  const before = fs.readFileSync(file, "utf8");
  check("provider id with path chars refused", writeSecret("../evil", { apiKey: "x" }).ok === false);
  check("empty provider id refused", writeSecret("", { apiKey: "x" }).ok === false);
  check("provider id with space refused", writeSecret("a b", { apiKey: "x" }).ok === false);
  check("empty key refused", writeSecret("openai", { apiKey: "" }).ok === false);
  check("oversized key refused", writeSecret("openai", { apiKey: "x".repeat(4097) }).ok === false);
  check("non-http baseUrl refused", writeSecret("openai", { baseUrl: "file:///etc/passwd", apiKey: "x" }).ok === false);
  check("file untouched by refused writes", fs.readFileSync(file, "utf8") === before);

  // 4. updates preserve other providers and unknown fields; baseUrl-only edit keeps the key
  fs.writeFileSync(file, JSON.stringify({ openai: { baseUrl: "https://a", apiKey: "k1", note: "keep" }, other: { apiKey: "k2" } }));
  const w2 = writeSecret("openai", { baseUrl: "https://b" });
  check("baseUrl-only write ok", w2.ok === true, JSON.stringify(w2));
  const after2 = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, string>>;
  check("baseUrl-only write keeps the key", after2.openai.apiKey === "k1" || (encryptionAvailable() && isEncryptedValue(after2.openai.apiKey)));
  check("unknown fields preserved", after2.openai.note === "keep");
  check("other providers untouched", after2.other.apiKey === "k2");
  check("read reflects new baseUrl", readSecret("openai")?.baseUrl === "https://b");

  // 5. an encrypted blob with no keychain: stated refusal with the reason
  if (!encryptionAvailable()) {
    fs.writeFileSync(file, JSON.stringify({ openai: { baseUrl: "https://a", apiKey: "enc1:AAAA" } }));
    let err: SecretError | null = null;
    try { readSecret("openai"); } catch (e) { err = e as SecretError; }
    check("encrypted blob without keychain throws", err instanceof SecretError);
    check("refusal names the cause (keychain unavailable)", err?.code === "keychain-unavailable", err?.code);
    check("refusal points at the desktop app", /desktop app/i.test(err?.message ?? ""), err?.message);
    // The agent loop keeps only the first 240 characters of a model error
    // (agentLoop.ts): a longer reason would lose its final instruction.
    check("the reason survives the agent loop's 240-char cap", (err?.message.length ?? 999) <= 240, `len ${err?.message.length}`);
    const e = encryptAllSecrets();
    check("encryptAll refuses without a keychain", e.ok === false && /desktop app/i.test(e.error ?? ""), e.error);
    // 6. encryptAll leaves the file byte-identical when it refuses
    fs.writeFileSync(file, JSON.stringify({ openai: { apiKey: "still-plain" } }));
    const snap = fs.readFileSync(file, "utf8");
    encryptAllSecrets();
    check("refused encryptAll does not modify the file", fs.readFileSync(file, "utf8") === snap);
  } else {
    check("SKIP no-keychain refusals (a keychain IS available in this process)", true);
  }

  // 7. status never carries key material
  fs.writeFileSync(file, JSON.stringify({ openai: { baseUrl: "https://a", apiKey: "sk-do-not-leak-123" }, anthropic: { apiKey: "sk-ant-do-not-leak" } }));
  const st = secretsStatus();
  const stJson = JSON.stringify(st);
  check("status omits every key value", !stJson.includes("do-not-leak"));
  check("status lists providers", st.providers.map((p) => p.provider).sort().join(",") === "anthropic,openai");
  check("status reports plaintext state", st.providers.every((p) => p.encrypted === encryptionAvailable()));
  check("status names its storage mode", st.storage === (encryptionAvailable() ? "os-keychain" : "plaintext-only"));
  check("headless note present exactly when the keychain is missing", (st.headlessNote !== null) === !encryptionAvailable());

  // 8. delete
  check("delete removes the provider", deleteSecret("anthropic").ok === true && readSecret("anthropic") === null);
  check("deleting a missing provider is refused", deleteSecret("nope").ok === false);
  check("delete leaves other providers", readSecret("openai") !== null);

  // 9. damaged / oversized files are plain absences, never throws
  fs.writeFileSync(file, "{ not json");
  check("corrupt file reads as null", readSecret("openai") === null);
  fs.writeFileSync(file, JSON.stringify({ openai: { apiKey: "x".repeat(70 * 1024) } }));
  check("oversized file reads as null", readSecret("openai") === null);

  // 10. atomic writes leave no temporary files behind
  fs.writeFileSync(file, "{}");
  writeSecret("openai", { apiKey: "k" });
  writeSecret("openai", { apiKey: "k2" });
  check("no temp files left behind", fs.readdirSync(dir).every((f) => f === "secrets.json"), fs.readdirSync(dir).join(","));

  console.log(failures === 0 ? "[ehc] secrets tests: ALL PASS" : `[ehc] secrets tests: ${failures} FAILURE(S)`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] secrets tests crashed:", e); process.exit(1); });
