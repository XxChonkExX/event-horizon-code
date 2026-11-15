// Event Horizon Code - Agent turn runner
//
// One turn of the coding agent: history + compaction, memory and instruction
// injection, model-lane selection (BYOK / bundled engine / Ollama), the bounded
// tool loop, and persistence. Extracted from the ACP handler so multiple
// callers can drive it - chat (session/prompt), SOP agent nodes, and future
// multi-agent windows all run the SAME loop with the same discipline.
//
// Model-lane ladder: explicit provider (BYOK) -> running bundled engine ->
// Ollama -> honest "no model selected" error.

import fs from "node:fs";
import path from "node:path";
import { audit } from "./audit";
import { chat, chatOpenAI } from "./router";
import type { ChatMessage, ChatResult } from "./router";
import { loadMessages, saveMessages, touchSession, recordUsage, listInstructions } from "./store";
import { TOOL_SPECS, AGENT_SYSTEM, AGENT_CODER_SYSTEM } from "./agentTools";
import type { ToolDef } from "./agentTools";
import { splitToolset, searchTools } from "./toolSearch";
import { ensureMcpServers, mcpTools, hasMcpServers } from "./mcp";
import { runTool } from "./tools";
import type { ToolName } from "./tools";
import { engineEndpoint } from "./engine";

export type AgentTurnParams = {
  sessionId: string;
  text: string;
  workdir: string;
  think?: string;
  numPredict?: number;
  timeoutMs?: number;
  model?: string;
  provider?: string;
  images?: string[];
  autoApprove?: boolean;
  agent?: string;        // "default" | "coder"
  profileId?: string;
  // SOP agent nodes prepend role/step framing to the system prompt.
  extraSystem?: string;
  // Cooperative cancellation (ACP session/cancel): polled between steps.
  isCancelled?: () => boolean;
  // Progress callback for live UI (SSE already broadcast by the ACP layer).
  onStep?: (step: { name: string; ok: boolean; needsApproval: boolean; step: number }) => void;
};

export type AgentTurnResult = {
  ok: boolean;
  reply: string;
  thinking?: string;
  model: string;
  tokens?: number;
  attempts: number;
  budget: number;
  toolSteps: number;
  think: string;
  error?: string;
  cancelled?: boolean;
};

const clampBudget = (n: number) => Math.min(8192, Math.max(64, Math.round(n)));

// Workspace memory: AGENTS.md (the open convention, also used by Claude Code and
// OpenCode) plus .harness/memory.md (agent-written project memory). Read fresh so
// edits apply immediately; capped so a runaway file cannot flood the context.
function readWorkspaceMemory(workdir: string): string {
  const parts: string[] = [];
  for (const rel of ["AGENTS.md", path.join(".harness", "memory.md")]) {
    const p = path.join(workdir, rel);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 0 && st.size <= 200_000) {
        parts.push(`# ${rel}\n${fs.readFileSync(p, "utf8").slice(0, 20_000)}`);
      }
    } catch { /* absent is fine */ }
  }
  return parts.length ? "\n\nWorkspace memory (persistent project instructions):\n" + parts.join("\n\n") : "";
}

function readConfigDefaultModel(): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "config.json"), "utf8")) as { modelRouter?: { defaultModel?: string | null } };
    return cfg.modelRouter?.defaultModel ?? null;
  } catch { return null; }
}

function readSecret(provider: string): { baseUrl?: string; apiKey?: string } | null {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".harness", "secrets.json"), "utf8")) as Record<string, { baseUrl?: string; apiKey?: string }>;
    return s[provider] ?? null;
  } catch { return null; }
}

export async function runAgentTurn(p: AgentTurnParams): Promise<AgentTurnResult> {
  // Request param > active profile > project config > empty.
  const profile = p.profileId ? safeProfile(p.profileId) : null;
  const prof = profile?.settings ?? {};
  const profStr = (k: string): string | undefined => (typeof prof[k] === "string" ? (prof[k] as string) : undefined);
  const profNum = (k: string): number | undefined => (typeof prof[k] === "number" ? (prof[k] as number) : undefined);
  const usedModel = p.model ?? profStr("model") ?? readConfigDefaultModel() ?? "";
  const engineUp = engineEndpoint();
  const autoApprove = p.autoApprove === true || prof["autoApprove"] === true;
  const effThink = p.think ?? profStr("think") ?? "medium";
  const effTokens = p.numPredict ?? profNum("tokens") ?? 1024;
  const userMsg: ChatMessage = { role: "user", content: p.text, ...(p.images?.length ? { images: p.images } : {}) };

  // Conversation accumulates across agent steps AND across turns:
  // history from previous prompts in this session is seeded first, so
  // follow-ups ("sure", "make it blue") have context. Compaction keeps
  // long sessions bounded. Content-only persistence (tool_calls dropped).
  const HISTORY_CAP = 60_000; // ~15k tokens of prior conversation
  const histRaw = loadMessages(p.sessionId);
  let hist: ChatMessage[] = histRaw.map((m) => ({ role: m.role as ChatMessage["role"], content: m.content }));
  if (JSON.stringify(hist).length > HISTORY_CAP && hist.length > 8) {
    // Compact: keep the most recent turns verbatim, summarize the rest
    // with the same model (cheap call, no tools) or a deterministic digest.
    const keep = hist.slice(-6);
    const older = hist.slice(0, -6);
    let summary: ChatMessage | null = null;
    try {
      const digest = older.map((m) => `[${m.role}] ${m.content}`).join("\n").slice(0, 20_000);
      const sumRes = await chat(usedModel || "engine", [
        { role: "system", content: "You are a conversation compressor. Summarize the earlier part of this coding session: what the user asked, what was done, key file paths and decisions. Be terse and factual; no preamble." },
        { role: "user", content: digest },
      ], { think: "low", numPredict: 512, timeoutMs: 60000 });
      if (sumRes.ok && (sumRes.content ?? "").trim()) {
        summary = { role: "system", content: `[earlier conversation summary]\n${sumRes.content}` };
      }
    } catch { /* fall through to deterministic digest */ }
    if (!summary) {
      const files = older.flatMap((m) => (m.content.match(/[\w./-]+\.(ts|tsx|js|py|rs|go|md|json)/g) ?? [])).slice(0, 20);
      summary = { role: "system", content: `[earlier conversation truncated - key files mentioned: ${[...new Set(files)].join(", ") || "none"}]` };
    }
    hist = [summary, ...keep];
  }
  // Durable session instructions replay in the system prompt and are
  // re-injected after any compaction - they never fall out of context.
  const instr = listInstructions(p.sessionId);
  const instructionBlock = instr.length
    ? "\n\nSession instructions (durable - remembered via the remember tool, they persist across compaction):\n" +
      instr.map((i) => `- [${i.key}] ${i.text}`).join("\n")
    : "";
  const memoryBlock = readWorkspaceMemory(p.workdir);
  // Agent persona: "coder" borrows DeepSeek-coder discipline (read-first,
  // minimal diff, verify); anything else uses the standard agent prompt.
  const persona = p.agent === "coder" ? AGENT_CODER_SYSTEM : AGENT_SYSTEM;
  const convo: ChatMessage[] = [{ role: "system", content: persona + (p.extraSystem ?? "") + memoryBlock + instructionBlock }, ...hist, userMsg];
  // Tools = built-ins + any MCP servers configured (namespaced mcp_*).
  // Beyond a threshold, advertise a core set + tool_search and load the
  // rest on demand - a 60-tool MCP server would otherwise flood context.
  if (hasMcpServers()) { try { await ensureMcpServers(); } catch { /* audited in mcp.ts */ } }
  const allTools: ToolDef[] = [...TOOL_SPECS, ...mcpTools()];
  const { advertised } = splitToolset(allTools);

  // One model call on whichever lane applies, with the agent tool set.
  const callModel = async (budget: number, nudge: boolean): Promise<ChatResult> => {
    const msgs = nudge
      ? [...convo, { role: "system" as const, content: "Stop deliberating. Use your final answer or a tool call now." }]
      : convo;
    if (p.provider === "openai") {
      const secret = readSecret("openai");
      if (!secret?.apiKey || !secret.baseUrl) {
        return { ok: false, content: "", model: usedModel || "openai", error: "no BYOK key - put {\"openai\":{\"baseUrl\",\"apiKey\"}} in .harness/secrets.json (gitignored)" };
      }
      return chatOpenAI(usedModel || "gpt-4o-mini", msgs, { baseUrl: secret.baseUrl, apiKey: secret.apiKey, think: effThink, numPredict: budget, timeoutMs: p.timeoutMs, tools: advertised });
    }
    if (engineUp) {
      // Bundled chonkllama sidecar serves whatever GGUF it was started with; model field is informational.
      return chatOpenAI(usedModel || "engine", msgs, { baseUrl: engineUp, apiKey: "local", think: effThink, numPredict: budget, timeoutMs: p.timeoutMs, tools: advertised });
    }
    if (usedModel) {
      // Keep the model warm during a conversation: agent loops make
      // several calls per prompt and a cold reload costs minutes.
      return chat(usedModel, msgs, { think: effThink, numPredict: budget, timeoutMs: p.timeoutMs, tools: advertised, keepAlive: "5m" });
    }
    return { ok: false, content: "", model: "none", error: "no model selected" };
  };

  const busy = Boolean(usedModel || p.provider === "openai" || engineUp);
  let result: ChatResult | null = null;
  let budget = clampBudget(effTokens);
  let attempts = 0;
  let loadRetried = false;
  let cancelled = false;
  const steps: string[] = [];
  if (busy) {
    // Agent loop: model may call tools; we execute (respecting the
    // permission gate) and hand results back, then let it answer.
    // Bounded: 4 steps, and each step escalates at most 3x if thinking
    // eats the budget. Never loops forever.
    for (let step = 0; step < 4; step++) {
      // Cooperative cancel: honoured between steps; a model call already in
      // flight finishes first.
      if (p.isCancelled?.()) {
        cancelled = true;
        result = { ok: true, content: "(cancelled by request - run stopped between agent steps)", model: usedModel || "none" };
        break;
      }
      let r: ChatResult;
      let innerAttempts = 0;
      budget = clampBudget(effTokens);
      while (true) {
        innerAttempts++; attempts++;
        r = await callModel(budget, innerAttempts > 1);
        const empty = (r.content ?? "").trim().length === 0;
        const thought = (r.thinking ?? "").trim().length > 0;
        if (r.ok && empty && thought && !(r.toolCalls?.length) && innerAttempts < 3 && budget < 8192) {
          budget = Math.min(budget * 2, 8192);
          audit({ tool: "model.escalate", note: `${r.model} thinking exhausted -> retry at ${budget}` });
          continue;
        }
        break;
      }
      // Model-load failure (usually transient RAM pressure while other
      // work owns memory, or the engine still loading): retry once, then
      // report the cause plainly.
      if (!r.ok && /out-of-memory|startup failed|failed to initialize|oom|loading model|503|unavailable/i.test(r.error ?? "") && !loadRetried) {
        loadRetried = true;
        audit({ tool: "model.load-retry", note: `load not ready on ${r.model}` });
        await new Promise((res) => setTimeout(res, 8000));
        continue;
      }
      if (!r.ok && /out-of-memory|startup failed|failed to initialize|oom/i.test(r.error ?? "")) {
        result = { ...r, error: `local model could not load - the system is low on RAM (another process may be holding it). Free memory, pick a smaller model, or lower engine context. Underlying: ${(r.error ?? "").slice(0, 160)}` };
        break;
      }
      // Context-overflow recovery: shed the oldest turns and retry once
      // (Claude Code / OpenCode both compact-and-retry on "too long").
      if (!r.ok && /context|too long|exceed|overflow/i.test(r.error ?? "") && step === 0 && convo.length > 10) {
        const keep = convo.slice(-8);
        convo.splice(0, convo.length, convo[0], ...keep);
        audit({ tool: "model.context-recover", note: `shed to ${convo.length} messages` });
        continue;
      }
      if (!r.ok) { result = r; break; }
      if (r.toolCalls?.length) {
        convo.push({ role: "assistant", content: r.content ?? "", tool_calls: r.toolCalls });
        for (const tc of r.toolCalls) {
          if (tc.name === "tool_search") {
            // Deferred loading: return matching full schemas AND load
            // them into the advertised set for the next step, so the
            // model can call what it just found.
            const query = String(tc.args.query ?? "");
            const matches = searchTools(query, allTools, Number(tc.args.limit ?? 6) || 6);
            const have = new Set(advertised.map((t) => t.function.name));
            for (const m of matches) {
              const def = allTools.find((t) => t.function.name === m.name);
              if (def && !have.has(m.name)) advertised.push(def);
            }
            const out = matches.length
              ? matches.map((m) => JSON.stringify({ name: m.name, description: m.description, parameters: m.parameters })).join("\n")
              : `NO MATCHING TOOLS for "${query.slice(0, 80)}". Say so instead of improvising a tool call.`;
            steps.push(`OK tool_search(${JSON.stringify(query).slice(0, 80)})\n${out.slice(0, 400)}`);
            audit({ tool: "agent.tool_search", note: `${query.slice(0, 50)} -> ${matches.length}` });
            p.onStep?.({ name: "tool_search", ok: true, needsApproval: false, step });
            convo.push({ role: "tool", content: out, name: "tool_search", tool_call_id: tc.id });
            continue;
          }
          const res = await runTool(tc.name as ToolName, { ...tc.args, ...(autoApprove ? { approved: true } : {}) }, p.workdir);
          const out = (res.ok ? res.out : (res.error ?? "failed")).slice(0, 1500);
          const shortArgs = JSON.stringify(tc.args).slice(0, 100);
          steps.push(`${res.ok ? "OK" : "X "} ${tc.name}(${shortArgs})${res.needsApproval ? " - needs approval" : ""}\n${out.slice(0, 400)}`);
          audit({ tool: `agent.${tc.name}`, note: `ok=${res.ok}${res.needsApproval ? " needsApproval" : ""}` });
          p.onStep?.({ name: tc.name, ok: res.ok, needsApproval: Boolean(res.needsApproval), step });
          convo.push({ role: "tool", content: out, name: tc.name, tool_call_id: tc.id });
        }
        continue; // let the model react to tool results
      }
      result = r;
      break;
    }
  }
  if (!result && !busy) {
    return { ok: false, reply: `echo: ${p.text}`, model: "none", attempts: 0, budget, toolSteps: 0, think: effThink, error: "no model selected - pass a model, start the engine, or run Ollama" };
  }

  const res = result as ChatResult;
  const emptyContent = (res.content ?? "").trim().length === 0;
  const thought = (res.thinking ?? "").trim().length > 0;
  let replyText = res.ok ? res.content : `model error: ${res.error}`;
  if (res.ok && emptyContent && thought) {
    const tail = (res.thinking ?? "").slice(-400);
    replyText = `(no final answer after ${attempts} attempts, ${budget} tokens - the model spent every budget thinking. Raise "tokens" in the composer, or lower "think".)\n\n[thinking tail]\n${tail}`;
  }
  if (steps.length) {
    replyText = `- tool steps (${steps.length}) -\n${steps.join("\n\n")}\n\n- answer -\n${replyText}`;
  }
  if (!autoApprove && steps.some((s) => s.includes("needs approval"))) {
    replyText += `\n\n(tool calls needing approval were not executed - enable auto-approve in the composer, or approve via the paletted permission flow.)`;
  }
  audit({ tool: "model.chat", note: `${res.model} tokens=${res.tokens ?? "?"} ok=${res.ok} attempts=${attempts} budget=${budget} tools=${steps.length}` });
  // Persist conversation (excluding the volatile system prompt) so the
  // next turn has context. Tool-result messages keep their content.
  try {
    saveMessages(p.sessionId, convo.slice(1).map((m) => ({ role: m.role, content: m.content })));
    touchSession(p.sessionId);
    if (res.tokens) recordUsage(p.sessionId, res.model, res.tokens);
  } catch { /* persistence is best-effort; audit never blocks */ }
  return {
    ok: res.ok,
    reply: replyText,
    thinking: res.thinking,
    model: res.model,
    tokens: res.tokens,
    attempts,
    budget,
    toolSteps: steps.length,
    think: effThink,
    ...(cancelled ? { cancelled: true } : {}),
  };
}

function safeProfile(id: string): { settings: Record<string, unknown> } | null {
  try {
    // Lazy import avoided: store is cheap and side-effect free.
    const { getProfile } = require("./store") as typeof import("./store");
    return getProfile(id);
  } catch { return null; }
}
