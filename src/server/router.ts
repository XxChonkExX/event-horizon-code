// Event Horizon Code — Model router (local-first, BYOK)
// No shipped model. defaultModel null. Lists Ollama tags if reachable, else empty.

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
