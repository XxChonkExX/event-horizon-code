// Event Horizon Code - Chat template registry
//
// Vendored, canonical Jinja chat templates (resources/templates/*.jinja), taken
// from llama.cpp's models/templates directory (MIT). Those files are themselves
// the authoritative templates published by each model family, so we reuse them
// verbatim instead of hand-rolling.
//
// Why this exists: a GGUF carries an embedded chat template, but many community
// re-uploads (abliterated / fine-tuned / quantized) strip the tool-calling
// blocks. Without tool blocks llama-server reports supports_tools=false and the
// agent silently NARRATES actions instead of calling tools. Passing a canonical
// template with --chat-template-file restores real tool calling.

import fs from "node:fs";
import path from "node:path";

export type TemplateEntry = {
  id: string;         // family id, stable, used in config
  file: string;       // file name inside resources/templates
  tools: boolean;     // does this template render tools / tool calls?
  match: RegExp;      // tested against the lowercased model name or path
  note?: string;
};

// Ordered: first match wins, so put the most specific patterns first
// (qwen3-coder before qwen3, deepseek-v3.2 before deepseek, granite-4.1
// before granite, and so on).
export const TEMPLATES: TemplateEntry[] = [
  { id: "qwen3-coder",   file: "Qwen3-Coder.jinja",                        tools: true,  match: /qwen3[-_.]?coder/ },
  { id: "qwen3.5",       file: "Qwen3.5-4B.jinja",                         tools: true,  match: /qwen3[._-]?5/ },
  { id: "qwq",           file: "Qwen-QwQ-32B.jinja",                       tools: true,  match: /qwq/ },
  { id: "qwen3",         file: "Qwen-Qwen3-0.6B.jinja",                    tools: true,  match: /qwen3/ },
  { id: "qwen2.5",       file: "Qwen-Qwen2.5-7B-Instruct.jinja",           tools: true,  match: /qwen2[._-]?5/ },
  { id: "qwen2",         file: "Qwen-Qwen2.5-7B-Instruct.jinja",           tools: true,  match: /qwen2/ },

  { id: "deepseek-v4",   file: "deepseek-ai-DeepSeek-V4.jinja",            tools: true,  match: /deepseek[._-]?v?4/ },
  { id: "deepseek-v3.2", file: "deepseek-ai-DeepSeek-V3.2.jinja",          tools: true,  match: /deepseek[._-]?v?3[._-]?2/ },
  { id: "deepseek-v3.1", file: "deepseek-ai-DeepSeek-V3.1.jinja",          tools: true,  match: /deepseek[._-]?v?3[._-]?1/ },
  { id: "deepseek-r1",   file: "deepseek-ai-DeepSeek-R1-Distill-Qwen-32B.jinja", tools: true, match: /deepseek.*r1|r1[-_.]?distill/ },
  { id: "deepseek",      file: "deepseek-ai-DeepSeek-V3.1.jinja",          tools: true,  match: /deepseek/ },

  { id: "glm-4.7",       file: "GLM-4.7-Flash.jinja",                      tools: true,  match: /glm[-_.]?4[._-]?7/ },
  { id: "glm-4.6",       file: "GLM-4.6.jinja",                            tools: true,  match: /glm[-_.]?4[._-]?6/ },
  { id: "glm",           file: "GLM-4.6.jinja",                            tools: true,  match: /glm|chatglm|zhipu/ },

  { id: "granite-4.1",   file: "ibm-granite-granite-4.1.jinja",            tools: true,  match: /granite[-_.]?4[._-]?1/ },
  { id: "granite-4",     file: "ibm-granite-granite-4.0.jinja",            tools: true,  match: /granite[-_.]?4/ },
  { id: "granite",       file: "ibm-granite-granite-3.3-2B-Instruct.jinja", tools: true, match: /granite/ },

  { id: "gemma4",        file: "google-gemma-4-31B-it.jinja",              tools: true,  match: /gemma[-_.]?4/ },
  { id: "gemma2",        file: "google-gemma-2-2b-it.jinja",               tools: false, match: /gemma[-_.]?2/, note: "no tool blocks in the base template" },

  { id: "llama3.3",      file: "meta-llama-Llama-3.3-70B-Instruct.jinja",  tools: true,  match: /llama[-_.]?3[._-]?3/ },
  { id: "llama3",        file: "meta-llama-Llama-3.1-8B-Instruct.jinja",   tools: true,  match: /llama[-_.]?3|llama-3/ },

  { id: "ministral",     file: "mistralai-Ministral-3-14B-Reasoning-2512.jinja", tools: true, match: /ministral/ },
  { id: "devstral",      file: "unsloth-mistral-Devstral-Small-2507.jinja", tools: true, match: /devstral/ },
  { id: "mistral-nemo",  file: "mistralai-Mistral-Nemo-Instruct-2407.jinja", tools: true, match: /nemo/ },
  { id: "mistral",       file: "Mistral-Small-3.2-24B-Instruct-2506.jinja", tools: true, match: /mistral|mixtral/ },

  { id: "gpt-oss",       file: "openai-gpt-oss-120b.jinja",                tools: true,  match: /gpt[-_.]?oss/ },
  { id: "kimi-k3",       file: "Kimi-K3.jinja",                            tools: true,  match: /kimi[-_.]?k3/ },
  { id: "kimi-thinking", file: "Kimi-K2-Thinking.jinja",                   tools: true,  match: /kimi.*think/ },
  { id: "kimi",          file: "moonshotai-Kimi-K2.jinja",                 tools: true,  match: /kimi|moonshot/ },
  { id: "command-r",     file: "CohereForAI-c4ai-command-r-plus-tool_use.jinja", tools: true, match: /command[-_.]?r|cohere/ },
  { id: "phi",           file: "microsoft-Phi-3.5-mini-instruct.jinja",    tools: false, match: /phi[-_.]?[34]/, note: "base Phi template has no tools" },
  { id: "minimax-m3",    file: "MiniMax-M3.jinja",                         tools: true,  match: /minimax[-_.]?m3/ },
  { id: "minimax-m2",    file: "MiniMax-M2.jinja",                         tools: true,  match: /minimax[-_.]?m2/ },
  { id: "minimax",       file: "MiniMax-M1.jinja",                         tools: true,  match: /minimax/ },
  { id: "nemotron",      file: "NVIDIA-Nemotron-3-Nano-30B-A3B-BF16.jinja", tools: true, match: /nemotron/ },
  { id: "seed-oss",      file: "ByteDance-Seed-OSS.jinja",                 tools: true,  match: /seed[-_.]?oss/ },
  { id: "hermes",        file: "NousResearch-Hermes-3-Llama-3.1-8B-tool_use.jinja", tools: true, match: /hermes/ },
  { id: "functionary",   file: "meetkai-functionary-medium-v3.2.jinja",    tools: true,  match: /functionary/ },
  { id: "smollm",        file: "HuggingFaceTB-SmolLM3-3B.jinja",           tools: true,  match: /smollm/ },
  { id: "lfm2",          file: "LFM2.5-Instruct.jinja",                    tools: true,  match: /lfm[-_.]?2/ },
  { id: "hunyuan",       file: "tencent-Hy3.jinja",                        tools: true,  match: /hunyuan|hy[-_.]?3/ },
  { id: "solar",         file: "upstage-Solar-Open-100B.jinja",            tools: true,  match: /solar/ },
  { id: "stepfun",       file: "StepFun3.5-Flash.jinja",                   tools: true,  match: /step[-_.]?3|stepfun/ },
  { id: "reka",          file: "Reka-Edge.jinja",                          tools: true,  match: /reka/ },
  { id: "gigachat",      file: "GigaChat3.1-10B-A1.8B.jinja",              tools: true,  match: /gigachat/ },
  { id: "mimo",          file: "MiMo-VL.jinja",                            tools: true,  match: /mimo/ },
  { id: "minicpm",       file: "openbmb-MiniCPM5-1B.jinja",                tools: true,  match: /minicpm/ },
  { id: "apriel",        file: "unsloth-Apriel-1.5.jinja",                 tools: true,  match: /apriel/ },
  { id: "laguna",        file: "poolside-Laguna-XS-2.1.jinja",             tools: true,  match: /laguna/ },
  { id: "spark",         file: "Spark2.5.jinja",                           tools: true,  match: /spark/ },
  { id: "bielik",        file: "Bielik-11B-v3.0-Instruct.jinja",           tools: true,  match: /bielik/ },
  { id: "apertus",       file: "Apertus-8B-Instruct.jinja",                tools: true,  match: /apertus/ },
  { id: "rwkv",          file: "llama-cpp-rwkv-world.jinja",               tools: false, match: /rwkv/ },
];

// Candidate roots: repo-local first (dev), then next to the executable (packaged).
export function templateDirs(): string[] {
  return [
    path.join(process.cwd(), "resources", "templates"),
    path.join(path.dirname(process.execPath), "resources", "templates"),
  ];
}

export function templateDir(): string | null {
  for (const d of templateDirs()) {
    try { if (fs.statSync(d).isDirectory()) return d; } catch { /* try next */ }
  }
  return null;
}

export function listTemplateFiles(): string[] {
  const d = templateDir();
  if (!d) return [];
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith(".jinja")).sort();
  } catch { return []; }
}

// Pick the canonical template for a model name or path. Family id is stable and
// can be pinned in config; the file is what we actually pass to llama-server.
export function detectTemplate(modelNameOrPath: string): TemplateEntry | null {
  const s = (modelNameOrPath || "").toLowerCase();
  if (!s) return null;
  for (const t of TEMPLATES) if (t.match.test(s)) return t;
  return null;
}

// ---- GGUF metadata fallback ----
//
// Filenames do not always name the family (Ollama stores models as content-hash
// blobs: "sha256-370c28..."), and "auto" then resolves nothing, so tool calling
// depends on whatever the GGUF happens to embed. Reading the GGUF's general.*
// metadata keys and matching the SAME family regexes against them fixes
// detection without any new dependencies.
//
// GGUF header: magic u32 "GGUF", version u32, tensor_count u64, kv_count u64,
// then key-value pairs (key = u64 len + bytes; value = u32 type + payload).
// We walk only the metadata section and stop early: general.* keys are written
// first by every converter, before the large tokenizer arrays, and a bounded
// read keeps a huge vocab from being walked byte-by-byte.

const GGUF_MAGIC = 0x46554747; // "GGUF" little-endian
const GGUF_META_KEYS = ["general.name", "general.basename", "general.architecture", "general.finetune", "general.size_label"];
const GGUF_SCAN_CAP = 2 * 1024 * 1024; // metadata lives well inside this
const GGUF_ARRAY_BAIL = 4096; // a big array means we reached tokenizer territory

// Read the header + metadata of a GGUF, returning the general.* string values
// found. Returns [] for anything unreadable (not a GGUF, truncated) — callers
// treat that as "no metadata", never an error.
export function ggufGeneralStrings(p: string): string[] {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, "r");
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) < 24) return [];
    if (head.readUInt32LE(0) !== GGUF_MAGIC) return [];
    const kvCount = Number(head.readBigUInt64LE(16));
    const chunk = Buffer.alloc(Math.min(GGUF_SCAN_CAP, fs.fstatSync(fd).size - 24));
    if (fs.readSync(fd, chunk, 0, chunk.length, 24) < 1) return [];
    let off = 0;
    const str = (): string => {
      if (off + 8 > chunk.length) return "";
      const len = Number(chunk.readBigUInt64LE(off)); off += 8;
      if (len > chunk.length - off) return "";
      const s = chunk.toString("utf8", off, off + len); off += len;
      return s;
    };
    const skipValue = (t: number): boolean => {
      switch (t) {
        case 0: case 1: case 7: off += 1; return true;
        case 2: case 3: off += 2; return true;
        case 4: case 5: case 6: off += 4; return true;
        case 10: case 11: case 12: off += 8; return true;
        case 8: return str().length >= 0;
        case 9: {
          if (off + 12 > chunk.length) return false;
          const et = chunk.readUInt32LE(off); off += 4;
          const n = Number(chunk.readBigUInt64LE(off)); off += 8;
          if (n > GGUF_ARRAY_BAIL) return false; // tokenizer-scale: stop the scan
          for (let i = 0; i < n; i++) if (!skipValue(et)) return false;
          return true;
        }
        default: return false;
      }
    };
    const found: string[] = [];
    const n = Math.min(kvCount, 256);
    for (let i = 0; i < n; i++) {
      const key = str();
      if (off + 4 > chunk.length) break;
      const t = chunk.readUInt32LE(off); off += 4;
      if (GGUF_META_KEYS.includes(key) && t === 8) {
        const mark = off;
        const v = str();
        off = mark; // fall through: skipValue below must still advance past the value
        if (v) found.push(v);
      }
      const mark = off;
      if (!skipValue(t)) break;
      if (off <= mark) break; // no forward progress
    }
    return found;
  } catch { return []; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

// Family detection for a GGUF file: filename first, then embedded metadata.
export function detectTemplateFromGguf(p: string): TemplateEntry | null {
  const byName = detectTemplate(p);
  if (byName) return byName;
  const meta = ggufGeneralStrings(p);
  if (!meta.length) return null;
  return detectTemplate(meta.join(" "));
}

export type ResolvedTemplate = { path: string; file: string; id: string | null; tools: boolean; source: string };

// Resolve a selector into a concrete template file.
//   "auto" (or empty) -> detect from the model name
//   a family id        -> TEMPLATES entry
//   a bare *.jinja     -> file in resources/templates
//   an existing path   -> used as-is
export function resolveTemplate(selector: string | undefined, modelNameOrPath = ""): ResolvedTemplate | null {
  const dir = templateDir();
  const sel = (selector ?? "auto").trim();

  const asFile = (file: string, id: string | null, tools: boolean, source: string): ResolvedTemplate | null => {
    if (!dir) return null;
    const p = path.join(dir, file);
    try { if (fs.statSync(p).isFile()) return { path: p, file, id, tools, source }; } catch { return null; }
    return null;
  };

  // Explicit path the user pointed at (absolute, relative, or a .jinja here).
  const looksLikePath = sel && sel !== "auto" && /[\\/]/.test(sel);
  if ((looksLikePath || (sel && sel.toLowerCase().endsWith(".jinja"))) && fs.existsSync(sel)) {
    const entry = detectTemplate(path.basename(sel)) ?? detectTemplate(modelNameOrPath);
    return { path: path.resolve(sel), file: path.basename(sel), id: entry?.id ?? null, tools: entry?.tools ?? true, source: "path" };
  }

  // Family id.
  if (sel && sel !== "auto") {
    const byId = TEMPLATES.find((t) => t.id === sel);
    if (byId) { const r = asFile(byId.file, byId.id, byId.tools, "id"); if (r) return r; }
    // Bare file name inside the template dir.
    if (sel.toLowerCase().endsWith(".jinja")) { const r = asFile(sel, null, true, "file"); if (r) return r; }
  }

  // Auto: detect from the model name, then (for real GGUF files whose name
  // carries no family - Ollama content-hash blobs) from embedded metadata.
  let entry = detectTemplate(modelNameOrPath);
  if (!entry && modelNameOrPath && /\.gguf$/i.test(modelNameOrPath) && fs.existsSync(modelNameOrPath)) {
    entry = detectTemplateFromGguf(modelNameOrPath);
  }
  if (entry) { const r = asFile(entry.file, entry.id, entry.tools, "auto"); if (r) return r; }
  return null;
}

export function familyCatalog(): Array<{ id: string; file: string; tools: boolean; present: boolean }> {
  const present = new Set(listTemplateFiles());
  return TEMPLATES.map((t) => ({ id: t.id, file: t.file, tools: t.tools, present: present.has(t.file) }));
}
