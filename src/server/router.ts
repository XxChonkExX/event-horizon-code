// Event Horizon Code — Model router (local-first, BYOK)
// No shipped model. defaultModel null. Lists Ollama tags if reachable, else empty.
// Direct calls to the user's Ollama — no proxy, no middleman.

import { execFile } from "node:child_process";

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

// OpenAI-compatible chat (BYOK): works with OpenAI, OpenCode Console gateway
// (https://opencode.ai/inference/openai/v1), OpenRouter, vLLM, llama-server /v1, etc.
// Key comes from .harness/secrets.json (gitignored) — never from git, never logged.
// Convert our message shape to OpenAI content parts when images are present (vision, S1).
function toOpenAIMessages(messages: ChatMessage[], system: string) {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const m of messages) {
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_calls) base.tool_calls = m.tool_calls;
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

export async function chatOpenAI(
  model: string,
  messages: ChatMessage[],
  opts: { baseUrl: string; apiKey: string; think?: string; numPredict?: number; timeoutMs?: number; tools?: unknown[] }
): Promise<ChatResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const system = THINK_HINTS[opts.think ?? "medium"] ?? THINK_HINTS.medium;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(messages, system),
        max_tokens: opts.numPredict ?? 400,
        stream: false,
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      return { ok: false, content: "", model, error: `openai-compat ${res.status}: ${(await res.text()).slice(0, 200)}` };
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
function toWireMessages(messages: ChatMessage[]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
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
  opts?: { baseUrl?: string; think?: string; numPredict?: number; timeoutMs?: number; keepAlive?: number | string; tools?: unknown[] }
): Promise<ChatResult> {
  const baseUrl = opts?.baseUrl ?? process.env.EH_OLLAMA_URL ?? "http://127.0.0.1:11434";
  const think = opts?.think ?? "medium";
  const system = THINK_HINTS[think] ?? THINK_HINTS.medium;
  const thinkKey = `${baseUrl}|${model}`;
  const send = async (includeThink: boolean): Promise<globalThis.Response> => {
    // images ride on user turns; Ollama wants raw base64 (no data: prefix)
    const mapped = toWireMessages(messages).map((m, idx) => ({
      ...m,
      ...(messages[idx]?.images ? { images: messages[idx].images!.map((i) => (i.startsWith("data:") ? i.slice(i.indexOf(",") + 1) : i)) } : {}),
    }));
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "system", content: system }, ...mapped],
      stream: false,
      keep_alive: opts?.keepAlive ?? 0,
      options: { num_predict: opts?.numPredict ?? 256 },
    };
    if (opts?.tools?.length) body.tools = opts.tools;
    if (includeThink) body.think = mapThink(think);
    return fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 120_000),
    });
  };
  try {
    let res = await send(!thinkUnsupported.has(thinkKey));
    if (!res.ok && res.status === 400) {
      // Endpoint/model rejects `think` — remember it and retry without.
      const errText = await res.text();
      if (/think/i.test(errText)) {
        thinkUnsupported.add(thinkKey);
        res = await send(false);
      } else {
        return { ok: false, content: "", model, error: `ollama 400: ${errText.slice(0, 200)}` };
      }
    }
    if (!res.ok) {
      return { ok: false, content: "", model, error: `ollama ${res.status}: ${(await res.text()).slice(0, 200)}` };
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
