// MCP secret-reference tests (src/server/mcp.ts resolveMcpLaunch): the config
// surface that lets an MCP server's tokens live in the BYOK keychain instead
// of plaintext in config.json. Run: npm run mcpsecrets:test
//
// Uses a temp secrets file (plaintext, headless) and a temp audit log - the
// operator's real files are never in play.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSecret } from "../src/server/secrets";
import { resolveMcpLaunch } from "../src/server/mcp";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-mcp-secrets-"));
process.env.EH_SECRETS_FILE = path.join(dir, "secrets.json");
process.env.EH_AUDIT_LOG = path.join(dir, "audit.jsonl");

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  console.log("[ehc] mcp secret-reference tests");
  await writeSecret("github", { apiKey: "gh-token-123" });
  await writeSecret("linear", { apiKey: "lin-token-456", baseUrl: "https://mcp.linear.app/sse" });

  // 1. env references resolve; the referenced providers are reported
  const r1 = resolveMcpLaunch({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: "${secrets:github}", PLAIN: "literal", BOTH: "pre-${secrets:linear}-post" },
  });
  check("an env reference resolves to the stored key", r1.env.GITHUB_TOKEN === "gh-token-123", JSON.stringify(r1.env));
  check("literal env values pass through", r1.env.PLAIN === "literal");
  check("references embedded in a longer value resolve", r1.env.BOTH === "pre-lin-token-456-post", JSON.stringify(r1.env));
  check("the referenced providers are reported for the audit", r1.referenced.join(",") === "github,linear", JSON.stringify(r1.referenced));
  check("command and args without references pass through", r1.command === "npx" && r1.args.join(" ") === "-y @modelcontextprotocol/server-github");

  // 2. command/args may reference secrets too
  const r2 = resolveMcpLaunch({ command: "${secrets:linear:baseUrl}", args: ["--token=${secrets:github}"] });
  check("a command reference resolves", r2.command === "https://mcp.linear.app/sse", r2.command);
  check("an args reference resolves", r2.args[0] === "--token=gh-token-123", JSON.stringify(r2.args));
  check("command/args references are reported", r2.referenced.join(",") === "github,linear");

  // 3. executable-resolution env keys stay blocked, even with references
  const r3 = resolveMcpLaunch({ command: "x", env: { PATH: "${secrets:github}", NODE_OPTIONS: "${secrets:github}", GOOD: "${secrets:github}" } });
  check("blocked env keys are never resolved or passed", r3.env.PATH === undefined && r3.env.NODE_OPTIONS === undefined && r3.env.GOOD === "gh-token-123", JSON.stringify(r3.env));

  // 4. a missing referenced secret fails the launch with the name
  let err = "";
  try { resolveMcpLaunch({ command: "x", env: { TOKEN: "${secrets:ghost}" } }); } catch (e) { err = String((e as Error).message); }
  check("a reference to a missing secret throws with the name", /no secret stored for "ghost"/.test(err), err);

  // 5. a reference to an absent field fails the launch
  err = "";
  try { resolveMcpLaunch({ command: "x", env: { URL: "${secrets:github:baseUrl}" } }); } catch (e) { err = String((e as Error).message); }
  check("a reference to an absent field throws", /has no baseUrl/.test(err), err);

  // 6. a reference to an unreadable (sealed, no keychain) secret fails the launch
  // (the rewrite keeps github/big present for the checks below)
  fs.writeFileSync(process.env.EH_SECRETS_FILE!, JSON.stringify({
    sealed: { apiKey: "enc1:AAAA" },
    github: { apiKey: "gh-token-123" },
    big: { apiKey: "t".repeat(9000) },
  }));
  err = "";
  try { resolveMcpLaunch({ command: "x", env: { TOKEN: "${secrets:sealed}" } }); } catch (e) { err = String((e as Error).message); }
  check("a reference to an unreadable secret throws the keychain reason", /keychain/.test(err), err);

  // 7. oversized resolved values are dropped (bound on the RESOLVED size)
  await writeSecret("big", { apiKey: "t".repeat(9000) });
  const r7 = resolveMcpLaunch({ command: "x", env: { TOKEN: "${secrets:big}" } });
  check("a resolved value over the env bound is dropped", r7.env.TOKEN === undefined, `len ${String(r7.env.TOKEN ?? "").length}`);

  // 8. the resolution path itself never logs: resolveMcpLaunch performs no
  // audit writes, so no resolved token can reach the audit log from here.
  const auditPath = process.env.EH_AUDIT_LOG!;
  check("no audit log was written by the resolution path", !fs.existsSync(auditPath) || fs.readFileSync(auditPath, "utf8").length === 0, fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").slice(0, 120) : "");

  console.log(failures === 0 ? "[ehc] mcp secret-reference tests: ALL PASS" : `[ehc] mcp secret-reference tests: ${failures} FAILURE(S)`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] mcp secret-reference tests crashed:", e); process.exit(1); });
