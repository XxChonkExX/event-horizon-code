// Chat template registry tests: family detection (name + GGUF metadata),
// selector resolution, and the bounded GGUF header walk. Run: npm run templates:test
//
// The GGUF fixtures are synthesized in-memory (header + metadata bytes only -
// no tensors), so these tests never touch a real model file and run anywhere.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectTemplate, detectTemplateFromGguf, resolveTemplate, ggufGeneralStrings } from "../src/server/chatTemplates";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

// Build a minimal GGUF file: header + general.* KVs + one string array + one
// scalar KV after it (proves the scanner walks small arrays and scalars).
function writeSyntheticGguf(file: string, opts?: { bigArrayFirst?: boolean }): void {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(24);
  head.writeUInt32LE(0x46554747, 0); // "GGUF"
  head.writeUInt32LE(3, 4);          // version
  head.writeBigUInt64LE(0n, 8);      // tensor_count
  head.writeBigUInt64LE(opts?.bigArrayFirst ? 3n : 3n, 16); // kv_count
  parts.push(head);
  const str = (s: string): Buffer => {
    const b = Buffer.alloc(8 + Buffer.byteLength(s));
    b.writeBigUInt64LE(BigInt(Buffer.byteLength(s)), 0);
    b.write(s, 8, "utf8");
    return b;
  };
  const kv = (key: string, type: number, payload: Buffer): Buffer => Buffer.concat([str(key), Buffer.from([type & 0xff, 0, 0, 0]), payload]);
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
  const u64 = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n, 0); return b; };

  const generalName = kv("general.name", 8, str("gemma4-12b-it"));          // string
  const arch = kv("general.architecture", 8, str("gemma4"));                // string
  const align = kv("general.alignment", 4, u32(32));                        // scalar u32
  // Small string array (tokens): type 9, elem type 8, count 2.
  const tokens = Buffer.concat([u32(8), u64(2n), str("▁hello"), str("▁world")]);
  const tokensKv = kv("tokenizer.ggml.tokens", 9, tokens);

  if (opts?.bigArrayFirst) {
    // A >4096-count array BEFORE the general keys: the scanner must bail
    // honestly (bounded read) and report no metadata rather than hang.
    const huge = Buffer.concat([u32(8), u64(100000n), str("a"), str("b")]);
    parts.push(kv("tokenizer.some.huge", 9, huge), generalName, arch);
  } else {
    parts.push(generalName, arch, tokensKv, align);
  }
  fs.writeFileSync(file, Buffer.concat(parts));
}

async function main(): Promise<void> {
  console.log("[ehc] template registry tests");

  // 1. name-based detection, most specific first
  check("gemma4 by name", detectTemplate("gemma4:e4b")?.id === "gemma4");
  check("gemma4 dashed variant", detectTemplate("Gemma-4-12b-it")?.id === "gemma4");
  check("qwen3-coder wins over qwen3", detectTemplate("Qwen3-Coder-30B")?.id === "qwen3-coder");
  check("deepseek-v3.2 wins over deepseek", detectTemplate("DeepSeek-V3.2")?.id === "deepseek-v3.2");
  check("glm alias chatglm", detectTemplate("chatglm3")?.id === "glm");
  check("gemma2 is no-tools", detectTemplate("gemma-2-2b-it")?.tools === false);
  check("unknown family detects nothing", detectTemplate("totally-unknown-model") === null);
  check("empty string detects nothing", detectTemplate("") === null);

  // 2. selector resolution forms
  const byId = resolveTemplate("gemma4");
  check("family id resolves", Boolean(byId && byId.id === "gemma4" && byId.source === "id"));
  const auto = resolveTemplate("auto", "qwen3-4b-instruct.gguf");
  check("auto detects from model name", Boolean(auto && auto.id === "qwen3" && auto.source === "auto"));
  check("auto with no family resolves null (honest)", resolveTemplate("auto", "sha256-deadbeef") === null);

  // 3. GGUF metadata fallback - the Ollama blob case (hash filename)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ehc-gguf-"));
  try {
    const blob = path.join(dir, "sha256-370c2879f17648d337b0ab4e208fdce348e24d1060064e93d7645daafd56d39c.gguf");
    writeSyntheticGguf(blob);
    const meta = ggufGeneralStrings(blob);
    check("metadata strings extracted", meta.includes("gemma4-12b-it") && meta.includes("gemma4"), meta.join("|"));
    const fam = detectTemplateFromGguf(blob);
    check("family from GGUF metadata", fam?.id === "gemma4" && fam?.tools === true, fam?.id ?? "null");
    const r = resolveTemplate("auto", blob);
    check("resolveTemplate auto uses metadata fallback", Boolean(r && r.id === "gemma4" && r.source === "auto"), r ? `${r.id}/${r.source}` : "null");

    // 4. non-GGUF and truncated inputs are plain absences, never throws
    const junk = path.join(dir, "junk.gguf");
    fs.writeFileSync(junk, "this is not a gguf file, just text");
    check("non-GGUF returns no metadata", ggufGeneralStrings(junk).length === 0);
    check("non-GGUF detects no family", detectTemplateFromGguf(junk) === null);
    const trunc = path.join(dir, "trunc.gguf");
    fs.writeFileSync(trunc, Buffer.alloc(10)); // shorter than the 24-byte header
    check("truncated GGUF is a plain absence", ggufGeneralStrings(trunc).length === 0);

    // 5. bounded scan: huge array before general.* -> honest bail
    const bail = path.join(dir, "bail.gguf");
    writeSyntheticGguf(bail, { bigArrayFirst: true });
    check("huge array bails the scan honestly", ggufGeneralStrings(bail).length === 0);
    check("bailed scan detects no family (no guessing)", detectTemplateFromGguf(bail) === null);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }

  console.log(failures === 0 ? "[ehc] template tests: ALL PASS" : `[ehc] template tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] template tests crashed:", e); process.exit(1); });
