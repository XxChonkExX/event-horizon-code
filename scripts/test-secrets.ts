// BYOK secrets tests - the paths that need NO keychain: plaintext storage,
// honest refusal when an encrypted blob cannot be decrypted here, input
// validation, status privacy, atomic writes, backups. Run: npm run secrets:test
//
// The keychain path itself (encrypt -> disk -> decrypt under DPAPI/Keychain,
// across two launches) is proven by `npm run secrets:test:electron`, which
// bundles the module and runs it inside real Electron. Never touches the
// operator's real secrets file or backups: everything goes through env
// overrides pointing at temp directories.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readSecret, writeSecret, deleteSecret, encryptAllSecrets, secretsStatus,
  encryptionAvailable, isEncryptedValue, secretsPath, SecretError,
  backupsDir, createBackup, listBackups, deleteBackup, usableByokProviders,
  byokModelId, byokProviderFromModel, wrappingKeyOnDisk, hasSecretRefs, resolveSecretRefs,
} from "../src/server/secrets";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-secrets-"));
const file = path.join(dir, "secrets.json");
const backups = path.join(dir, "backups");
process.env.EH_SECRETS_FILE = file;
process.env.EH_BACKUPS_DIR = backups;

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}
// A check that cannot run on this platform is reported, not silently passed.
function skip(name: string, why: string): void { console.log(`  SKIP ${name} (${why})`); }

async function main(): Promise<void> {
  const keychain = encryptionAvailable();
  console.log(`[ehc] secrets tests (keychain available: ${keychain}, platform: ${process.platform})`);

  // 1. path override + absence is a plain null, never a throw
  check("path override honored", secretsPath() === file);
  check("backups dir override honored", backupsDir() === backups);
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
  const w = await writeSecret("openai", { baseUrl: "https://api.example.com/v1", apiKey: "sk-plaintext-test" });
  check("write succeeds", w.ok === true, JSON.stringify(w));
  check("write reports its storage state honestly", !w.ok || w.encrypted === keychain, JSON.stringify(w));
  check("write reports the durability verdict", !w.ok || w.settled === true, JSON.stringify(w));
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { openai: { baseUrl: string; apiKey: string } };
  check("baseUrl stays readable on disk", onDisk.openai.baseUrl === "https://api.example.com/v1");
  check("key on disk is plaintext exactly when no keychain", isEncryptedValue(onDisk.openai.apiKey) === keychain);
  const r = readSecret("openai");
  check("read roundtrips", r?.apiKey === "sk-plaintext-test" && r?.baseUrl === "https://api.example.com/v1");
  if (process.platform !== "win32") {
    const mode = fs.statSync(file).mode & 0o777;
    check("secrets file is owner-only (0600) on POSIX", mode === 0o600, mode.toString(8));
  } else {
    skip("secrets file is owner-only (0600) on POSIX", "POSIX modes do not apply on Windows - the file inherits the folder ACL");
  }

  // 3. validation refuses before touching the file
  const before = fs.readFileSync(file, "utf8");
  check("provider id with path chars refused", (await writeSecret("../evil", { apiKey: "x" })).ok === false);
  check("empty provider id refused", (await writeSecret("", { apiKey: "x" })).ok === false);
  check("provider id with space refused", (await writeSecret("a b", { apiKey: "x" })).ok === false);
  check("empty key refused", (await writeSecret("openai", { apiKey: "" })).ok === false);
  check("oversized key refused", (await writeSecret("openai", { apiKey: "x".repeat(4097) })).ok === false);
  check("non-http baseUrl refused", (await writeSecret("openai", { baseUrl: "file:///etc/passwd", apiKey: "x" })).ok === false);
  check("model with a line break refused", (await writeSecret("openai", { model: "a\nb" })).ok === false);
  check("oversized model refused", (await writeSecret("openai", { model: "m".repeat(201) })).ok === false);
  check("non-string model refused", (await writeSecret("openai", { model: 42 as unknown as string })).ok === false);
  check("file untouched by refused writes", fs.readFileSync(file, "utf8") === before);

  // 4. updates preserve other providers and unknown fields; baseUrl-only edit keeps the key
  fs.writeFileSync(file, JSON.stringify({ openai: { baseUrl: "https://a", apiKey: "k1", note: "keep" }, other: { apiKey: "k2" } }));
  const w2 = await writeSecret("openai", { baseUrl: "https://b" });
  check("baseUrl-only write ok", w2.ok === true, JSON.stringify(w2));
  const after2 = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, string>>;
  check("baseUrl-only write keeps the key", after2.openai.apiKey === "k1" || (keychain && isEncryptedValue(after2.openai.apiKey)));
  check("unknown fields preserved", after2.openai.note === "keep");
  check("other providers untouched", after2.other.apiKey === "k2");
  check("read reflects new baseUrl", readSecret("openai")?.baseUrl === "https://b");

  // 5. a per-provider default model: readable, validated, clearable
  const wm = await writeSecret("openai", { model: "  gpt-4o-mini " });
  check("model save ok", wm.ok === true, JSON.stringify(wm));
  check("model is trimmed and read back", readSecret("openai")?.model === "gpt-4o-mini");
  check("model save leaves key and baseUrl alone", readSecret("openai")?.apiKey === "k1" && readSecret("openai")?.baseUrl === "https://b");
  check("model on disk stays readable", (JSON.parse(fs.readFileSync(file, "utf8")) as { openai: { model: string } }).openai.model === "gpt-4o-mini");
  await writeSecret("openai", { model: "" });
  check("an empty model clears the field", readSecret("openai")?.model === undefined);

  // 5b. secret references (MCP config): "${secrets:<provider>[:field]}"
  await writeSecret("openai", { model: "gpt-4o-mini" });
  const refStore = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, string>>;
  check("hasSecretRefs detects references", hasSecretRefs("${secrets:openai}") === true && hasSecretRefs("${other:x}") === false && hasSecretRefs(undefined) === false);
  check("a bare reference resolves to the apiKey", resolveSecretRefs("token ${secrets:openai}") === `token ${refStore.openai.apiKey}`);
  check("field references resolve to their field", resolveSecretRefs("${secrets:openai:baseUrl}|${secrets:openai:model}") === "https://b|gpt-4o-mini");
  check("multiple references in one string all resolve", resolveSecretRefs("${secrets:openai:baseUrl} key=${secrets:openai} m=${secrets:openai:model}") === `https://b key=${refStore.openai.apiKey} m=gpt-4o-mini`);
  check("non-secret syntax passes through untouched", resolveSecretRefs("${secrets:} ${secrets:has.dot} $secrets:x") === "${secrets:} ${secrets:has.dot} $secrets:x");
  let refErr: SecretError | null = null;
  try { resolveSecretRefs("${secrets:ghost}"); } catch (e) { refErr = e as SecretError; }
  check("a reference to a missing secret throws with the name", refErr instanceof SecretError && /no secret stored for "ghost"/.test(refErr.message ?? ""), refErr?.message);
  refErr = null;
  fs.appendFileSync(file, ""); // (no-op: keep the file as the assertions above left it)
  await writeSecret("minimal", { apiKey: "only-a-key" });
  try { resolveSecretRefs("${secrets:minimal:baseUrl}"); } catch (e) { refErr = e as SecretError; }
  check("a reference to an absent field throws", refErr instanceof SecretError && /has no baseUrl/.test(refErr.message ?? ""), refErr?.message);
  if (!keychain) {
    fs.writeFileSync(file, JSON.stringify({ sealed: { apiKey: "enc1:AAAA" } }));
    refErr = null;
    try { resolveSecretRefs("${secrets:sealed}"); } catch (e) { refErr = e as SecretError; }
    check("a reference to an unreadable secret throws the keychain reason", refErr instanceof SecretError && refErr.code === "keychain-unavailable", refErr?.message);
    fs.writeFileSync(file, JSON.stringify({ openai: { baseUrl: "https://b", apiKey: "k1" } }));
  } else {
    skip("reference to an unreadable secret", "a keychain IS available in this process");
  }
  await writeSecret("openai", { model: "" });

  // 6. an encrypted blob with no keychain: stated refusal with the reason
  if (!keychain) {
    fs.writeFileSync(file, JSON.stringify({ openai: { baseUrl: "https://a", apiKey: "enc1:AAAA" } }));
    let err: SecretError | null = null;
    try { readSecret("openai"); } catch (e) { err = e as SecretError; }
    check("encrypted blob without keychain throws", err instanceof SecretError);
    check("refusal names the cause (keychain unavailable)", err?.code === "keychain-unavailable", err?.code);
    check("refusal points at the desktop app", /desktop app/i.test(err?.message ?? ""), err?.message);
    // The agent loop keeps only the first 240 characters of a model error
    // (agentLoop.ts): a longer reason would lose its final instruction.
    check("the reason survives the agent loop's 240-char cap", (err?.message.length ?? 999) <= 240, `len ${err?.message.length}`);
    const e = await encryptAllSecrets();
    check("encryptAll refuses without a keychain", e.ok === false && /desktop app/i.test(e.error ?? ""), e.error);
    // 7. encryptAll leaves the file byte-identical when it refuses
    fs.writeFileSync(file, JSON.stringify({ openai: { apiKey: "still-plain" } }));
    const snap = fs.readFileSync(file, "utf8");
    await encryptAllSecrets();
    check("refused encryptAll does not modify the file", fs.readFileSync(file, "utf8") === snap);
  } else {
    skip("no-keychain refusals", "a keychain IS available in this process");
  }

  // 8. status never carries key material
  fs.writeFileSync(file, JSON.stringify({ openai: { baseUrl: "https://a", apiKey: "sk-do-not-leak-123", model: "gpt-4o-mini" }, anthropic: { apiKey: "sk-ant-do-not-leak" } }));
  const st = secretsStatus();
  const stJson = JSON.stringify(st);
  check("status omits every key value", !stJson.includes("do-not-leak"));
  check("status lists providers", st.providers.map((p) => p.provider).sort().join(",") === "anthropic,openai");
  check("status reports plaintext state", st.providers.every((p) => p.encrypted === keychain));
  check("status names its storage mode", st.storage === (keychain ? "os-keychain" : "plaintext-only"));
  check("headless note present exactly when the keychain is missing", (st.headlessNote !== null) === !keychain);
  const row = st.providers.find((p) => p.provider === "openai");
  check("status shows the non-secret fields (baseUrl, model)", row?.baseUrl === "https://a" && row?.model === "gpt-4o-mini", JSON.stringify(row));
  check("byok helpers", byokModelId("openai") === "byok:openai" && byokProviderFromModel("byok:openai") === "openai");
  check("byok helpers reject malformed selections", byokProviderFromModel("byok:../x") === null && byokProviderFromModel("byok:") === null && byokProviderFromModel("gpt-4o") === null && byokProviderFromModel(undefined) === null);
  check("usable BYOK providers = key + baseUrl that this runtime can read", usableByokProviders().map((p) => p.provider).join(",") === "openai", JSON.stringify(usableByokProviders()));
  // (anthropic has a key but no base URL -> not offered.)
  fs.writeFileSync(file, JSON.stringify({ ok: { baseUrl: "https://a", apiKey: "k", model: "m" }, nomodel: { baseUrl: "https://b", apiKey: "k" }, nobase: { apiKey: "k" }, sealed: { baseUrl: "https://a", apiKey: "enc1:AAAA" } }));
  const usable = usableByokProviders().map((p) => p.provider).sort().join(",");
  // Offered only with key + base URL + model; `enc1:AAAA` is not a real sealed
  // value, so it is unreadable everywhere and never offered.
  check("a provider is offered only with key + base URL + model, readable here", usable === "ok", usable);
  check("wrapping-key check is not applicable outside Electron", wrappingKeyOnDisk() === null);

  // 9. delete
  fs.writeFileSync(file, JSON.stringify({ openai: { baseUrl: "https://a", apiKey: "k1" }, anthropic: { apiKey: "k2" } }));
  check("delete removes the provider", deleteSecret("anthropic").ok === true && readSecret("anthropic") === null);
  check("deleting a missing provider is refused", deleteSecret("nope").ok === false);
  check("delete leaves other providers", readSecret("openai") !== null);

  // 10. damaged / oversized files are plain absences, never throws
  fs.writeFileSync(file, "{ not json");
  check("corrupt file reads as null", readSecret("openai") === null);
  fs.writeFileSync(file, JSON.stringify({ openai: { apiKey: "x".repeat(70 * 1024) } }));
  check("oversized file reads as null", readSecret("openai") === null);

  // 11. atomic writes leave no temporary files behind, and saves that can
  // wait (sealing) never lose one another.
  fs.writeFileSync(file, "{}");
  await writeSecret("openai", { apiKey: "k" });
  await writeSecret("openai", { apiKey: "k2" });
  await Promise.all([writeSecret("a", { apiKey: "ka" }), writeSecret("b", { apiKey: "kb" }), writeSecret("c", { apiKey: "kc" })]);
  const afterRace = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { apiKey: string }>;
  check("concurrent saves all land (no lost update)", afterRace.a?.apiKey === "ka" && afterRace.b?.apiKey === "kb" && afterRace.c?.apiKey === "kc", Object.keys(afterRace).join(","));
  check("no temp files left behind", fs.readdirSync(dir).every((f) => f === "secrets.json" || f === "backups"), fs.readdirSync(dir).join(","));

  // 12. plaintext backups: exact copy of the file, confined to the backups
  // directory, never created for a missing file, deletable only by a valid name.
  fs.rmSync(file, { force: true });
  check("no backup without a secrets file", createBackup().ok === false);
  const srcText = JSON.stringify({ openai: { baseUrl: "https://a", apiKey: "sk-do-not-leak-123" } }, null, 2) + "\n";
  fs.writeFileSync(file, srcText);
  const b1 = createBackup();
  check("backup created", b1.ok === true && b1.bytes === Buffer.byteLength(srcText), JSON.stringify(b1));
  if (b1.ok) {
    check("backup is a byte-identical copy", fs.readFileSync(b1.path, "utf8") === srcText);
    check("backup lives under the backups dir and is called secrets.json", b1.path.startsWith(backups + path.sep) && path.basename(b1.path) === "secrets.json", b1.path);
    check("backup file is never inside the workspace/secrets dir", !path.resolve(b1.path).startsWith(path.resolve(dir, "secrets.json")));
    if (process.platform !== "win32") {
      const fm = fs.statSync(b1.path).mode & 0o777;
      const dm = fs.statSync(path.dirname(b1.path)).mode & 0o777;
      check("backup file is 0600 and its folder 0700 on POSIX", fm === 0o600 && dm === 0o700, `${dm.toString(8)}/${fm.toString(8)}`);
    }
  }
  const b2 = createBackup();
  check("a second backup in the same second gets its own folder", b2.ok === true && (!b1.ok || b2.path !== b1.path));
  const listed = listBackups();
  check("backups are listed newest first with provider names only", listed.length === 2 && listed[0].name >= listed[1].name && listed.every((b) => b.providers.join(",") === "openai" && b.bytes > 0), JSON.stringify(listed));
  check("backup listing carries no key material", !JSON.stringify(listed).includes("do-not-leak"));
  check("status includes the backups", secretsStatus().backups.length === 2);
  const namesBefore = listBackups().map((b) => b.name).join(",");
  for (const bad of ["..", "../" + path.basename(dir), "a/b", "a\\b", "", "secrets.json", "x".repeat(500)]) {
    check(`backup delete refuses the name ${JSON.stringify(bad.slice(0, 24))}`, deleteBackup(bad).ok === false);
  }
  check("refused deletes removed nothing", listBackups().map((b) => b.name).join(",") === namesBefore);
  const gone = listBackups().pop();
  if (gone) {
    check("a listed backup can be deleted", deleteBackup(gone.name).ok === true && !fs.existsSync(path.join(backups, gone.name)));
    check("deleting it again is refused as missing", deleteBackup(gone.name).ok === false);
  }
  check("one backup remains", listBackups().length === 1);

  console.log(failures === 0 ? "[ehc] secrets tests: ALL PASS" : `[ehc] secrets tests: ${failures} FAILURE(S)`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] secrets tests crashed:", e); process.exit(1); });
