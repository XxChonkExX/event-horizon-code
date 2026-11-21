// Event Horizon Code — Durable Agent Run (Phase 1)
//
// The run is a first-class entity: Session = conversation, Run = work being
// performed. A run survives window close, restart, and model switch — state
// plus an append-only event timeline live in SQLite via the session store
// (roadmap Phase 1).
//
// This module owns the state machine; store.ts owns the tables. Transitions
// are validated, every transition and significant step appends a timeline
// event, and a runtime restart marks in-flight runs `interrupted` (the
// conversation survived — messages persist — but the work stopped; resume
// execution is a later phase).

import {
  createAgentRun, getAgentRun, listAgentRuns, listRunEvents,
  updateAgentRun, appendRunEvent, markStaleRunsInterrupted,
  type AgentRun, type AgentRunState,
} from "./store";
import { audit } from "./audit";

export type { AgentRun, AgentRunState };

export { markStaleRunsInterrupted };

export const TERMINAL_STATES: readonly AgentRunState[] = ["completed", "failed", "cancelled"];

// Allowed transitions. Terminal states have no exits; `interrupted` re-enters
// running when resume execution lands (a later phase).
const TRANSITIONS: Record<AgentRunState, readonly AgentRunState[]> = {
  queued: ["planning", "running", "cancelled", "failed"],
  planning: ["running", "awaiting_approval", "cancelled", "failed"],
  running: ["awaiting_approval", "checkpointed", "verifying", "completed", "failed", "cancelled", "interrupted"],
  awaiting_approval: ["running", "cancelled", "failed", "interrupted"],
  checkpointed: ["running", "verifying", "cancelled", "failed", "interrupted"],
  verifying: ["completed", "needs_repair", "failed", "cancelled"],
  needs_repair: ["planning", "running", "cancelled", "failed"],
  interrupted: ["running", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: AgentRunState, to: AgentRunState): boolean {
  return from !== to && TRANSITIONS[from]?.includes(to);
}

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Create a run and open its timeline. State starts at `queued`.
export function beginRun(opts: { sessionId: string; objective: string; workdir: string; model?: string; lane?: string }): AgentRun {
  const now = new Date().toISOString();
  const run: AgentRun = {
    id: newRunId(),
    sessionId: opts.sessionId,
    objective: opts.objective.slice(0, 200),
    workdir: opts.workdir,
    state: "queued",
    lane: opts.lane ?? null,
    model: opts.model ?? null,
    started: now,
    updated: now,
    ended: null,
    error: null,
    result: null,
  };
  createAgentRun(run);
  appendRunEvent(run.id, "run.created", `objective: ${run.objective}`);
  return run;
}

// Validated transition + timeline event. Returns the updated run, or an error
// naming the refused move - never silently ignored.
export function transition(runId: string, to: AgentRunState, note?: string): { ok: boolean; run?: AgentRun; error?: string } {
  const run = getAgentRun(runId);
  if (!run) return { ok: false, error: `unknown run ${runId}` };
  if (TERMINAL_STATES.includes(run.state)) return { ok: false, error: `run ${runId} is ${run.state} (terminal) - no transitions` };
  if (!canTransition(run.state, to)) return { ok: false, error: `illegal transition ${run.state} -> ${to}` };
  const patch: Partial<AgentRun> = { state: to };
  if (to === "completed" || to === "failed" || to === "cancelled") patch.ended = new Date().toISOString();
  updateAgentRun(runId, patch);
  appendRunEvent(runId, "state.change", `${run.state} -> ${to}${note ? ` (${note})` : ""}`);
  audit({ tool: "agentrun.state", note: `${runId} ${run.state} -> ${to}${note ? ` ${note.slice(0, 80)}` : ""}` });
  return { ok: true, run: getAgentRun(runId)! };
}

export function runTimeline(runId: string): { run: AgentRun | null; events: ReturnType<typeof listRunEvents> } {
  return { run: getAgentRun(runId), events: listRunEvents(runId) };
}

export { getAgentRun, listAgentRuns, listRunEvents, appendRunEvent };

// Convenience finalizers used by the agent loop - each is a validated
// transition plus a terminal event, and the disposition is written onto the
// row itself (error/result), not just the timeline.
export function completeRun(runId: string, result: string): { ok: boolean; run?: AgentRun; error?: string } {
  const r = transition(runId, "completed", result.slice(0, 120));
  if (r.ok) {
    updateAgentRun(runId, { result: result.slice(0, 500) });
    appendRunEvent(runId, "run.completed", result.slice(0, 500));
  }
  return r;
}

export function failRun(runId: string, error: string): { ok: boolean; run?: AgentRun; error?: string } {
  const r = transition(runId, "failed", error.slice(0, 120));
  if (r.ok) {
    updateAgentRun(runId, { error: error.slice(0, 500) });
    appendRunEvent(runId, "run.failed", error.slice(0, 500));
  }
  return r;
}

export function cancelRun(runId: string, by = "operator"): { ok: boolean; run?: AgentRun; error?: string } {
  const r = transition(runId, "cancelled", `by ${by}`);
  if (r.ok) appendRunEvent(runId, "run.cancelled", `cancelled by ${by}`);
  return r;
}

// ---- Phase 2: resume ----

// Validate an interrupted run for resume and build the recovery prompt: the
// objective plus a digest of the timeline (what already happened), so the
// model continues from the record rather than starting blind. NO transition
// happens here - the agent loop owns `interrupted -> running` when it takes
// over with p.runId (single ownership, no double-transition races).
export function resumeRun(runId: string): { ok: boolean; run?: AgentRun; resumeText?: string; error?: string } {
  const run = getAgentRun(runId);
  if (!run) return { ok: false, error: `unknown run ${runId}` };
  if (run.state !== "interrupted") return { ok: false, error: `run ${runId} is ${run.state} - only interrupted runs can be resumed` };
  const events = listRunEvents(runId);
  const digest = events
    .slice(-14)
    .map((e) => `- ${e.kind}: ${e.detail.slice(0, 160)}`)
    .join("\n");
  const resumeText = [
    `Resume the interrupted task. Objective: ${run.objective}`,
    "",
    "Progress so far (run timeline, oldest last):",
    digest || "(no events recorded)",
    "",
    "Continue from where it stopped and finish the objective. Do not repeat steps the timeline shows already succeeded.",
  ].join("\n");
  return { ok: true, run, resumeText };
}
