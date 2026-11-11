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
    if (m.images && m.images.length > 0) {
      const parts: Array<Record<string, unknown>> = [{ type: "text", text: m.content }];
      for (const img of m.images) {
        parts.push({ type: "image_url", image_url: { url: img.startsWith("data:") ? img : "data:image/png;base64," + img } });
      }
      out.push({ role: m.role, content: parts });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export async function chatOpenAI(
  model: string,
  messages: ChatMessage[],
  opts: { baseUrl: string; apiKey: string; think?: string; numPredict?: number; timeoutMs?: number }
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
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      return { ok: false, content: "", model, error: `openai-compat ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const j = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      usage?: { completion_tokens?: number };
    };
    return {
      ok: true,
      content: j.choices?.[0]?.message?.content ?? "",
      thinking: j.choices?.[0]?.message?.reasoning_content,
      model,
      tokens: j.usage?.completion_tokens,
    };
  } catch (e) {
    return { ok: false, content: "", model, error: String(e).slice(0, 200) };
  }
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  // Vision (S1): image data URLs or local paths — converted per provider.
  // Ollama: images[] (base64). OpenAI-compatible: content parts with image_url.
  images?: string[];
};
export type ChatResult = { ok: boolean; content: string; thinking?: string; model: string; tokens?: number; error?: string };

const THINK_HINTS: Record<string, string> = {
  low: "Answer briefly and directly.",
  medium: "Answer clearly with key steps.",
  high: "Think step by step. Be careful and verify details before answering.",
  max: "Think this through thoroughly, step by step, checking your work. Note any uncertainty explicitly.",
};

// Direct chat to local Ollama. keepAlive 0 unloads the model from VRAM right after
// the request — smoke tests leave the GPU clear for whatever else needs it.
export async function chat(
  model: string,
  messages: ChatMessage[],
  opts?: { baseUrl?: string; think?: string; numPredict?: number; timeoutMs?: number; keepAlive?: number }
): Promise<ChatResult> {
  const baseUrl = opts?.baseUrl ?? process.env.EH_OLLAMA_URL ?? "http://127.0.0.1:11434";
  const think = opts?.think ?? "medium";
  const system = THINK_HINTS[think] ?? THINK_HINTS.medium;
  const body = {
    model,
    messages: [{ role: "system", content: system }, ...messages.map((m) => ({ ...m, images: m.images?.map((i) => (i.startsWith("data:") ? i.slice(i.indexOf(",") + 1) : i)) }))],
    stream: false,
    keep_alive: opts?.keepAlive ?? 0,
    options: { num_predict: opts?.numPredict ?? 256 },
  };
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 120_000),
    });
    if (!res.ok) {
      return { ok: false, content: "", model, error: `ollama ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    // Reasoning models (gemma4, qwen3…) put chain-of-thought in message.thinking, answer in message.content.
    const j = (await res.json()) as { message?: { content?: string; thinking?: string }; eval_count?: number };
    return { ok: true, content: j.message?.content ?? "", thinking: j.message?.thinking, model, tokens: j.eval_count };
  } catch (e) {
    return { ok: false, content: "", model, error: String(e).slice(0, 200) };
  }
}
