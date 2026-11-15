// Event Horizon Code - Tool search for large toolsets
//
// With MCP servers merged in, the advertised tool list can exceed what a model
// can usefully hold in context. Beyond a threshold we advertise a small core set
// plus a `tool_search` meta-tool; the model finds the rest on demand, and the
// matching full schemas are loaded into the advertised set for the next step
// (the deferred-loading pattern Anthropic calls tool search).

import type { ToolDef } from "./agentTools";

// Always advertised: the tools nearly every task needs, plus the search handle.
export const CORE_TOOL_NAMES = new Set([
  "read", "ls", "grep", "glob", "edit", "write", "bash",
  "todo", "remember", "verify", "tool_search",
]);

export const TOOL_SEARCH_SPEC: ToolDef = {
  type: "function",
  function: {
    name: "tool_search",
    description: "Find tools by what you need (e.g. 'screenshot', 'query database', 'browser click'). Returns the full schemas of the best matches so you can call them. Use this whenever a task seems to need a tool you have not been given.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What the tool should do, in plain words." }, limit: { type: "string", description: "Max matches (default 6)." } },
      required: ["query"],
    },
  },
};

const STOP = new Set([
  "the", "a", "an", "for", "and", "or", "of", "to", "in", "on", "with", "by",
  "is", "are", "be", "this", "that", "it", "as", "at", "from", "use", "using",
]);

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1 && !STOP.has(t));
}

export type ToolMatch = { name: string; description: string; parameters: unknown; score: number };

// Keyword-overlap scoring across the tool name and description. Deterministic,
// dependency-free, and good enough to put the right tool in the top few.
export function searchTools(query: string, tools: ToolDef[], limit = 6): ToolMatch[] {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const scored = tools
    .filter((t) => t.function.name !== "tool_search")
    .map((t) => {
      const nameTokens = tokenize(t.function.name.replace(/_/g, " "));
      const descTokens = tokenize(t.function.description);
      let score = 0;
      for (const term of terms) {
        if (t.function.name.toLowerCase().includes(term)) score += 4;
        if (nameTokens.some((n) => n === term || n.startsWith(term) || term.startsWith(n))) score += 3;
        const exact = descTokens.filter((d) => d === term).length;
        score += Math.min(exact, 3) * 2;
        if (descTokens.some((d) => d.startsWith(term))) score += 1;
      }
      return { name: t.function.name, description: t.function.description, parameters: t.function.parameters, score };
    })
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, limit));
  return scored;
}

// Split a full toolset into the advertised core and the deferrable rest.
export function splitToolset(all: ToolDef[], threshold = 25): { advertised: ToolDef[]; deferred: ToolDef[]; search: boolean } {
  if (all.length <= threshold) return { advertised: all, deferred: [], search: false };
  const core = all.filter((t) => CORE_TOOL_NAMES.has(t.function.name));
  const deferred = all.filter((t) => !CORE_TOOL_NAMES.has(t.function.name));
  return { advertised: [...core, TOOL_SEARCH_SPEC], deferred, search: true };
}
