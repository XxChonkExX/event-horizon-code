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

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
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
    messages: [{ role: "system", content: system }, ...messages],
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
