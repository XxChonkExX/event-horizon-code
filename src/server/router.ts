// Event Horizon Code — Model router (local-first, BYOK)
// No shipped model. defaultModel null. Lists Ollama tags if reachable, else empty.
// Direct calls to the user's Ollama — no proxy, no middleman.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetch as ufetch } from "undici";
import { pinnedAgent, resolveHostAddrs } from "./dnspin";
import { audit } from "./audit";

export type ModelInfo = { id: string; openaiId?: string; capabilities?: string[] };

export async function listModels(ollamaUrl = "http://127.0.0.1:11434"): Promise<ModelInfo[]> {
  // Try ollama list first (timeout), else empty. Never downloads.
  return new Promise((resolve) => {
    execFile("ollama", ["list"], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        // Try HTTP tags endpoint via fetch (Node 18+). If unreachable, empty list is honest.
        fetch(`${ollamaUrl}/api/tags`)
          .then((r) => (r.ok ? r.json() : null))
          .then((j) => {
            const models = (j as { models?: Array<{ name: string; model?: string }> } | null)?.models ?? [];
            resolve(models.map((m) => ({ id: m.name, openaiId: m.model })));
          })
          .catch(() => resolve([]));
        return;
      }
      const lines = String(stdout).split("\n").slice(1).filter(Boolean);
      const models = lines.map((l) => ({ id: l.split(/\s+/)[0] }));
      resolve(models);
    });
  });
}

// ---- capabilities: what a model can actually do (tools / vision / thinking) ----
//
// Ollama reports this via POST /api/show {model} -> capabilities[]. The bundled
// engine reports it via GET /props (modalities + chat_template_caps). Results are
// cached: the UI asks on every model switch and this must stay cheap.

export type ModelCaps = { model: string; capabilities: string[]; source: "engine" | "ollama" | "unknown"; note?: string };
const capsCache = new Map<string, { at: number; caps: ModelCaps }>();

export async function modelCapabilities(model: string, opts?: { engineBase?: string | null; refresh?: boolean }): Promise<ModelCaps> {
  const key = `${opts?.engineBase ? "engine" : "ollama"}:${model}`;
  const hit = capsCache.get(key);
  if (hit && !opts?.refresh && Date.now() - hit.at < 60_000) return hit.caps;

  // Bundled engine lane: everything is served by the running sidecar, so the
  // engine's own /props is the truth regardless of the requested model name.
  if (opts?.engineBase) {
    try {
      const base = opts.engineBase.replace(/\/v1$/, "");
      const res = await fetch(`${base}/props`, { signal: AbortSignal.timeout(4000) });
      const j = (await res.json()) as {
        // llama.cpp builds differ: modalities is either an array of names or an
        // object of { vision: bool, audio: bool, ... } flags.
        modalities?: string[] | Record<string, boolean>;
        chat_template_caps?: { supports_tools?: boolean };
        default_generation_settings?: { n_ctx?: number };
      };
      const capabilities: string[] = ["completion"];
      const mods = j.modalities;
      const has = (name: string): boolean =>
        Array.isArray(mods) ? mods.includes(name) : Boolean(mods && typeof mods === "object" && (mods as Record<string, boolean>)[name]);
      if (has("vision")) capabilities.push("vision");
      if (has("audio")) capabilities.push("audio");
      if (j.chat_template_caps?.supports_tools) capabilities.push("tools");
      const caps: ModelCaps = { model, capabilities, source: "engine", note: `context ${j.default_generation_settings?.n_ctx ?? "?"}` };
      capsCache.set(key, { at: Date.now(), caps });
      return caps;
    } catch {
      const caps: ModelCaps = { model, capabilities: [], source: "unknown", note: "engine not reachable" };
      return caps;
    }
  }

  // Ollama lane.
  try {
    const res = await fetch(`${OLLAMA_DEFAULT}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as { capabilities?: string[]; details?: { parameter_size?: string } };
    const caps: ModelCaps = { model, capabilities: j.capabilities ?? [], source: "ollama", note: j.details?.parameter_size };
    capsCache.set(key, { at: Date.now(), caps });
    return caps;
  } catch (e) {
    const caps: ModelCaps = { model, capabilities: [], source: "unknown", note: `probe failed: ${String((e as Error).message ?? e).slice(0, 60)}` };
    capsCache.set(key, { at: Date.now(), caps });
    return caps;
  }
}

const OLLAMA_DEFAULT = process.env.EH_OLLAMA_URL ?? "http://127.0.0.1:11434";

// Normalize whatever shape we stored (our ToolCall {id,name,args}, or an OpenAI
// {id,type,function:{name,arguments}}) into the wire format every backend wants.
// llama-server rejects a tool_calls item with a missing `type`, which is exactly
// what the internal shape produces, so convert here rather than at each call site.
// Tool arguments arrive as objects (Ollama) or JSON-encoded strings (OpenAI).
// Never emit malformed JSON: a truncated string from an upstream parser becomes
// an empty object rather than a wire-breaking payload.
function parseToolArgs(args: unknown): unknown {
  if (typeof args === "string") {
    try { return JSON.parse(args); } catch { return {}; }
  }
  return args ?? {};
}

function toOpenAIToolCalls(tcs: unknown, argsAsObject = false): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tcs) || !tcs.length) return undefined;
  return tcs.map((tc) => {
    const t = tc as { id?: string; name?: string; args?: unknown; function?: { name?: string; arguments?: unknown } };
    const name = t.name ?? t.function?.name ?? "";
    const args = parseToolArgs(t.args !== undefined ? t.args : t.function?.arguments);
    return {
      id: t.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
      type: "function",
      function: { name, arguments: argsAsObject ? args : JSON.stringify(args) },
    };
  });
}

// OpenAI-compatible chat (BYOK): works with OpenAI, OpenCode Console gateway
// (https://opencode.ai/inference/openai/v1), OpenRouter, vLLM, llama-server /v1, etc.
// Key comes from .harness/secrets.json (gitignored) — never from git, never logged.
// Convert our message shape to OpenAI content parts when images are present (vision, S1).
function toOpenAIMessages(messages: ChatMessage[], system: string) {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    const tcs = toOpenAIToolCalls(m.tool_calls);
    if (tcs) base.tool_calls = tcs;
    if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
    if (m.name) base.name = m.name;
    if (m.images && m.images.length > 0) {
      const parts: Array<Record<string, unknown>> = [{ type: "text", text: m.content }];
      for (const img of m.images) {
        parts.push({ type: "image_url", image_url: { url: img.startsWith("data:") ? img : "data:image/png;base64," + img } });
      }
      base.content = parts;
    }
    out.push(base);
  }
  return out;
}

// Incremental tool-call assembly for streaming responses: OpenAI-compatible
// servers send name/arguments in fragments keyed by index.
type ToolAcc = { id?: string; name?: string; args?: string };

function accumulateToolCalls(acc: Map<number, ToolAcc>, deltas: unknown): void {
  if (!Array.isArray(deltas)) return;
  for (const tc of deltas as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
    const i = tc.index ?? 0;
    const cur = acc.get(i) ?? {};
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name = (cur.name ?? "") + tc.function.name;
    if (tc.function?.arguments) cur.args = (cur.args ?? "") + tc.function.arguments;
    acc.set(i, cur);
  }
}

function toolCallsFrom(acc: Map<number, ToolAcc>): ToolCall[] {
  return Array.from(acc.values())
    .filter((t) => t.name)
    .map((t) => ({ id: t.id, name: t.name ?? "", args: parseArgs(t.args) }));
}

export async function chatOpenAI(
  model: string,
  messages: ChatMessage[],
  opts: { baseUrl: string; apiKey: string; think?: string; numPredict?: number; timeoutMs?: number; tools?: unknown[]; onDelta?: (delta: string, kind?: "content" | "reasoning") => void }
): Promise<ChatResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const system = THINK_HINTS[opts.think ?? "medium"] ?? THINK_HINTS.medium;
  try {
    const streaming = Boolean(opts.onDelta);
    // Pin the connection to the configured endpoint's resolved addresses: the
    // URL is the operator's, the resolution is not - a rebinding resolver must
    // not receive the Authorization header. LAN endpoints (llama-server,
    // LM Studio, vLLM) resolve normally: pinning is per resolved address, and
    // loopback/LAN hosts are first-class BYOK endpoints.
    const ips = await resolveHostAddrs(new URL(url).hostname);
    let res: Awaited<ReturnType<typeof ufetch>>;
    try {
      res = await ufetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model,
          messages: toOpenAIMessages(messages, system),
          max_tokens: opts.numPredict ?? 400,
          stream: streaming,
          ...(opts.tools?.length ? { tools: opts.tools } : {}),
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
        dispatcher: pinnedAgent(ips),
      });
    } catch (e) {
      if ((e as Error)?.name === "TimeoutError") {
        const secs = Math.round((opts.timeoutMs ?? 300_000) / 1000);
        return { ok: false, content: "", model, error: `model timed out after ${secs}s - it was still loading or busy; try again` };
      }
      return { ok: false, content: "", model, error: `endpoint unreachable: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
    }
    if (!res.ok) {
      return { ok: false, content: "", model, error: `openai-compat ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    // ---- streaming path: emit deltas as they arrive, assemble the same result ----
    if (streaming && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let text = "";
      let thinking = "";
      let tokens: number | undefined;
      const acc = new Map<number, ToolAcc>();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: unknown } }>;
              usage?: { completion_tokens?: number };
            };
            const delta = j.choices?.[0]?.delta;
            if (delta?.content) { text += delta.content; opts.onDelta?.(delta.content, "content"); }
            // Reasoning streams first on thinking models - surface it separately
            // so the UI can show a muted "thinking" line instead of silence.
            if (delta?.reasoning_content) { thinking += delta.reasoning_content; opts.onDelta?.(delta.reasoning_content, "reasoning"); }
            if (delta?.tool_calls) accumulateToolCalls(acc, delta.tool_calls);
            if (j.usage?.completion_tokens) tokens = j.usage.completion_tokens;
          } catch { /* partial or non-JSON keepalive line */ }
        }
      }
      const toolCalls = toolCallsFrom(acc);
      return { ok: true, content: text, thinking: thinking || undefined, model, tokens, toolCalls: toolCalls.length ? toolCalls : undefined };
    }
    const j = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } }>;
      usage?: { completion_tokens?: number };
    };
    const toolCalls: ToolCall[] = (j.choices?.[0]?.message?.tool_calls ?? [])
      .map((tc) => ({ id: tc.id, name: tc.function?.name ?? "", args: parseArgs(tc.function?.arguments) }))
      .filter((tc) => tc.name);
    return {
      ok: true,
      content: j.choices?.[0]?.message?.content ?? "",
      thinking: j.choices?.[0]?.message?.reasoning_content,
      model,
      tokens: j.usage?.completion_tokens,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
  } catch (e) {
    return { ok: false, content: "", model, error: String(e).slice(0, 200) };
  }
}

export type ToolCall = { id?: string; name: string; args: Record<string, unknown> };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // Vision (S1): image data URLs or local paths — converted per provider.
  // Ollama: images[] (base64). OpenAI-compatible: content parts with image_url.
  images?: string[];
  // Agent loop: assistant tool calls echoed back, and tool results.
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
};
export type ChatResult = { ok: boolean; content: string; thinking?: string; model: string; tokens?: number; toolCalls?: ToolCall[]; error?: string };

function parseArgs(a: unknown): Record<string, unknown> {
  if (!a) return {};
  if (typeof a === "object") return a as Record<string, unknown>;
  try { return JSON.parse(String(a)) as Record<string, unknown>; } catch { return {}; }
}

// Pass our message shapes through to the wire, preserving tool call plumbing.
// argsAsObject: Ollama mis-parses a re-sent assistant tool_calls arguments
// STRING when it contains escaped quotes ("can't find closing '}' symbol") -
// it must receive the parsed object. The OpenAI lane wants the string form.
function toWireMessages(messages: ChatMessage[], argsAsObject = false) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(() => { const tcs = toOpenAIToolCalls(m.tool_calls, argsAsObject); return tcs ? { tool_calls: tcs } : {}; })(),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name ? { name: m.name } : {}),
  }));
}

const THINK_HINTS: Record<string, string> = {
  low: "Answer briefly and directly.",
  medium: "Answer clearly with key steps.",
  high: "Think step by step. Be careful and verify details before answering.",
  max: "Think this through thoroughly, step by step, checking your work. Note any uncertainty explicitly.",
};

// Ollama thinking models (gemma4, qwen3, gpt-oss) accept a native `think` field.
// Most of them expose binary levels (false|true); some expose effort names. We
// map our /think: selector onto it so the control actually governs reasoning —
// previously it only shaped the system prompt and the model thought unchecked
// until the token budget died (thinking, no answer).
function mapThink(level?: string): boolean | string {
  switch ((level ?? "medium").toLowerCase()) {
    case "low": return false;      // no reasoning channel — fastest, always yields content
    case "medium": return false;   // binary models have no middle: prefer usable output
    case "high": return true;
    case "max": return true;
    default: return false;
  }
}

// Models/endpoints that reject the `think` field — remembered so we only pay the
// failed round-trip once per model.
const thinkUnsupported = new Set<string>();

// Direct chat to local Ollama. keepAlive 0 unloads the model from VRAM right after
// the request — smoke tests leave the GPU clear for whatever else needs it.
export async function chat(
  model: string,
  messages: ChatMessage[],
  // keepAlive: seconds (0 = unload immediately) or a duration string like "5m".
  // numCtx: context window. Ollama's default for vision-capable models can be
  // 131k, which allocates large CPU buffers — cap it (8k is ample for coding).
  // onDelta: stream tokens as they arrive (NDJSON lines from /api/chat).
  opts?: { baseUrl?: string; think?: string; numPredict?: number; numCtx?: number; timeoutMs?: number; keepAlive?: number | string; tools?: unknown[]; onDelta?: (delta: string, kind?: "content" | "reasoning") => void }
): Promise<ChatResult> {
  const baseUrl = opts?.baseUrl ?? process.env.EH_OLLAMA_URL ?? "http://127.0.0.1:11434";
  // Zero-download policy: Ollama implicitly PULLS a missing tag over the
  // network. EHC never downloads - verify the model exists locally first.
  const installed = await listModels(baseUrl);
  if (installed.length > 0 && !installed.some((m) => m.id === model)) {
    return { ok: false, content: "", model, error: `model "${model}" is not installed in Ollama - install it yourself first (ollama pull ${model}); EHC never downloads models` };
  }
  const think = opts?.think ?? "medium";
  const system = THINK_HINTS[think] ?? THINK_HINTS.medium;
  const thinkKey = `${baseUrl}|${model}`;
  // Built outside send so a failed request can be captured verbatim.
  const buildBody = (includeThink: boolean): Record<string, unknown> => {
    // images ride on user turns; Ollama wants raw base64 (no data: prefix)
    // argsAsObject=true: Ollama cannot re-parse string arguments (see toWireMessages).
    const mapped = toWireMessages(messages, true).map((m, idx) => ({
      ...m,
      ...(messages[idx]?.images ? { images: messages[idx].images!.map((i) => (i.startsWith("data:") ? i.slice(i.indexOf(",") + 1) : i)) } : {}),
    }));
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "system", content: system }, ...mapped],
      stream: Boolean(opts?.onDelta),
      keep_alive: opts?.keepAlive ?? 0,
      options: { num_predict: opts?.numPredict ?? 256, num_ctx: opts?.numCtx ?? 8192 },
    };
    if (opts?.tools?.length) body.tools = opts.tools;
    if (includeThink) body.think = mapThink(think);
    return body;
  };
  const send = async (includeThink: boolean): Promise<globalThis.Response> => {
    const body = buildBody(includeThink);
    return fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 300_000),
    });
  };
  try {
    let res: globalThis.Response;
    try {
      res = await send(!thinkUnsupported.has(thinkKey));
    } catch (e) {
      // AbortSignal.timeout rejects with a DOMException named TimeoutError -
      // surface it as a fact, not a stack ("aborted due to timeout" told the
      // user nothing). Local GGUFs can legitimately take minutes to load.
      if ((e as Error)?.name === "TimeoutError") {
        const secs = Math.round((opts?.timeoutMs ?? 300_000) / 1000);
        return { ok: false, content: "", model, error: `model timed out after ${secs}s - the local model was still loading or busy; try again (first load can take minutes)` };
      }
      return { ok: false, content: "", model, error: `ollama unreachable: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
    }
    if (!res.ok && res.status === 400) {
      // Endpoint/model rejects `think` - remember it and retry without.
      const errText = await res.text();
      if (/think/i.test(errText)) {
        thinkUnsupported.add(thinkKey);
        res = await send(false);
      } else {
        // Parse-style 400s mean OUR body is malformed for Ollama - dump the
        // whole body to disk so the failure is fully inspectable.
        try {
          const dump = path.join(os.homedir(), ".eventhorizon", "last-400-body.json");
          fs.mkdirSync(path.dirname(dump), { recursive: true });
          fs.writeFileSync(dump, JSON.stringify(buildBody(!thinkUnsupported.has(thinkKey)), null, 2));
        } catch { /* best-effort */ }
        audit({ tool: "model.400", note: `ollama 400: ${errText.slice(0, 200)} | body dumped to ~/.eventhorizon/last-400-body.json` });
        return { ok: false, content: "", model, error: `ollama 400: ${errText.slice(0, 200)}` };
      }
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      // A 400 with a parse-style error means OUR body is malformed for Ollama -
      // capture the body head so the next report is actionable.
      audit({ tool: "model.400", note: `ollama ${res.status}: ${detail} | body: ${JSON.stringify(buildBody(!thinkUnsupported.has(thinkKey))).slice(0, 900)}` });
      return { ok: false, content: "", model, error: `ollama ${res.status}: ${detail}` };
    }
    // ---- streaming path: NDJSON lines, one partial message each ----
    if (opts?.onDelta && res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let content = "";
      let thinking = "";
      let evalCount: number | undefined;
      const toolCalls: ToolCall[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          try {
            const j = JSON.parse(line) as {
              message?: { content?: string; thinking?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> };
              done?: boolean;
              eval_count?: number;
            };
            const d = j.message;
            if (d?.content) { content += d.content; opts.onDelta(d.content, "content"); }
            if (d?.thinking) { thinking += d.thinking; opts.onDelta(d.thinking, "reasoning"); }
            for (const tc of d?.tool_calls ?? []) {
              if (tc.function?.name) toolCalls.push({ id: tc.id, name: tc.function.name, args: parseArgs(tc.function.arguments) });
            }
            if (j.eval_count) evalCount = j.eval_count;
          } catch { /* partial line */ }
        }
      }
      return { ok: true, content, thinking: thinking || undefined, model, tokens: evalCount, toolCalls: toolCalls.length ? toolCalls : undefined };
    }
    // Reasoning models (gemma4, qwen3…) put chain-of-thought in message.thinking, answer in message.content.
    const j = (await res.json()) as {
      message?: { content?: string; thinking?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> };
      eval_count?: number;
    };
    const toolCalls: ToolCall[] = (j.message?.tool_calls ?? [])
      .map((tc) => ({ id: tc.id, name: tc.function?.name ?? "", args: parseArgs(tc.function?.arguments) }))
      .filter((tc) => tc.name);
    return { ok: true, content: j.message?.content ?? "", thinking: j.message?.thinking, model, tokens: j.eval_count, toolCalls: toolCalls.length ? toolCalls : undefined };
  } catch (e) {
    return { ok: false, content: "", model, error: String(e).slice(0, 200) };
  }
}
