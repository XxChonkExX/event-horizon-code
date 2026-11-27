// Event Horizon Code - approvals and grants (the operator's authority).
//
// Permission `ask` means: a human decides, for exactly this call. This module
// holds the requests that are waiting and the grants a human creates from
// them. Nothing here is reachable by the model: the tool gate creates
// requests, decisions arrive only through the operator channel (the renderer,
// via the IPC proxy), and grants live in memory for the life of the runtime -
// a restart forgets every grant on purpose.
//
// The bounds a grant may have live in ONE policy object (approvalPolicy). A
// build may raise or lower them through setApprovalPolicy; it may not remove
// the rule that a human creates every grant.

import crypto from "node:crypto";
import { audit } from "./audit";
import { broadcast } from "./sse";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type ApprovalSummary = { kind: "edit" | "write" | "bash" | "camera" | "generic"; title: string; detail: string };

export type ApprovalRequest = {
  id: string;
  sessionId: string;
  runId: string | null;
  worktree: string;
  tool: string;
  argsDigest: string;      // the decision binds to exactly these arguments
  summary: ApprovalSummary; // what the human reads before deciding
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  decidedAt: number | null;
  grantId: string | null;
};

// A grant answers `ask` without a prompt. `argsDigest` set: only that exact
// call. null: every call of that tool in that session.
export type Grant = {
  id: string;
  sessionId: string;
  tool: string;
  argsDigest: string | null;
  maxUses: number | null;  // null: unbounded while the runtime lives
  used: number;
  expiresAt: number | null;
  createdAt: number;
  label: string;
  viaApprovalId: string;
};

export type GrantSpec = { scope: "args" | "tool"; uses?: number | null; ttlMs?: number | null; label?: string };
export type AskOutcome = "approved" | "denied" | "expired" | "cancelled";
export type Decision = { approved: boolean; reason: AskOutcome; grantId: string | null };

export type ApprovalPolicy = {
  requestTimeoutMs: number; // a prompt nobody answers is a stated non-execution
  grantMaxUses: number;     // largest finite `uses` a grant may name
  grantMaxTtlMs: number;    // longest time-to-live a grant may name
  keepResolved: number;     // how many resolved requests stay listable
  noGrantTools: string[];   // tools that ask on EVERY use and can never be covered by a grant
};

// The floor for noGrantTools: a build may add to it, never remove from it.
// PRIVACY.md promises that a camera look asks each time; a grant would
// silently turn one yes into a standing permission to sense.
const ALWAYS_ASK_TOOLS = ["camera_look"];

const policy: ApprovalPolicy = { requestTimeoutMs: 10 * 60_000, grantMaxUses: 10_000, grantMaxTtlMs: 24 * 3600_000, keepResolved: 100, noGrantTools: [...ALWAYS_ASK_TOOLS] };

export function getApprovalPolicy(): Readonly<ApprovalPolicy> {
  return { ...policy, noGrantTools: [...policy.noGrantTools] };
}

/** True for a tool that must ask on every use. */
export function alwaysAsks(tool: string): boolean {
  return policy.noGrantTools.includes(tool);
}

// The premium seam: a build may move the bounds, within the floors below.
export function setApprovalPolicy(patch: Partial<ApprovalPolicy>): { ok: true } | { ok: false; error: string } {
  const next = { ...policy, ...patch };
  if (!Number.isInteger(next.requestTimeoutMs) || next.requestTimeoutMs < 1000 || next.requestTimeoutMs > 24 * 3600_000) return { ok: false, error: "requestTimeoutMs must be 1 s .. 24 h" };
  if (!Number.isInteger(next.grantMaxUses) || next.grantMaxUses < 1) return { ok: false, error: "grantMaxUses must be a positive integer" };
  if (!Number.isInteger(next.grantMaxTtlMs) || next.grantMaxTtlMs < 1000) return { ok: false, error: "grantMaxTtlMs must be at least 1 s" };
  if (!Number.isInteger(next.keepResolved) || next.keepResolved < 0 || next.keepResolved > 1000) return { ok: false, error: "keepResolved must be 0 .. 1000" };
  if (!Array.isArray(next.noGrantTools) || next.noGrantTools.some((t) => typeof t !== "string" || !t)) return { ok: false, error: "noGrantTools must be a list of tool names" };
  if (!ALWAYS_ASK_TOOLS.every((t) => next.noGrantTools.includes(t))) return { ok: false, error: `noGrantTools can be extended, never reduced (${ALWAYS_ASK_TOOLS.join(", ")} ask on every use)` };
  Object.assign(policy, next);
  audit({ tool: "approval", note: `policy timeout=${policy.requestTimeoutMs} maxUses=${policy.grantMaxUses} maxTtl=${policy.grantMaxTtlMs}` });
  return { ok: true };
}

// ---- the call's identity --------------------------------------------------------------

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = canonical(o[k]); return acc; }, {});
  }
  return v;
}

/** Stable identity of a call: the tool name and its arguments, key order irrelevant. */
export function callDigest(tool: string, args: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(`${tool}\0${JSON.stringify(canonical(args ?? {}))}`).digest("hex").slice(0, 32);
}

// ---- what the human reads ---------------------------------------------------------------

const DETAIL_CAP = 4000;

function clip(s: string, cap = DETAIL_CAP): string {
  return s.length > cap ? `${s.slice(0, cap)}\n… (${(s.length - cap).toLocaleString("en-US")} more characters)` : s;
}

/** The lines that differ between two texts (common head and tail removed). */
export function changedLines(oldText: string | null, newText: string): string {
  const a = (oldText ?? "").split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  if (oldText !== null && removed.length === 0 && added.length === 0) return "(no change - the content is identical)";
  const MAX = 200;
  const cut = (lines: string[]): string[] => (lines.length > MAX ? [...lines.slice(0, MAX), `… (${lines.length - MAX} more lines)`] : lines);
  const out = [...cut(removed).map((l) => `- ${l}`), ...cut(added).map((l) => `+ ${l}`)];
  return clip(`@@ around line ${head + 1} (${removed.length} removed, ${added.length} added) @@\n${out.join("\n")}`);
}

/** A bounded look at a file for the summary: its text; or, when it is too large to diff, only its size. */
export type FilePeek = { text: string; truncated?: boolean; bytes?: number } | null;

/**
 * The human-facing summary of a call. `readText` supplies the current file
 * content (relative path -> peek, or null when absent) so edits show as a
 * diff. Content is included on purpose: it is exactly what the human must see.
 */
export function summarizeCall(tool: string, args: Record<string, unknown>, readText?: (relPath: string) => FilePeek): ApprovalSummary {
  const rel = String(args.path ?? "").slice(0, 300);
  const big = (old: NonNullable<FilePeek>, next: string): string => clip(`(the file is too large to show a diff - ${((old.bytes ?? 0) / 1048576).toFixed(1)} MB; this REPLACES all of it)\n--- new content ---\n${next}`);
  switch (tool) {
    case "edit": {
      const newText = String(args.newText ?? "");
      if (!readText) return { kind: "edit", title: `Edit ${rel}`, detail: clip(newText) };
      const old = readText(rel);
      if (old === null) return { kind: "edit", title: `Edit ${rel}`, detail: clip(`(the file does not exist, so this edit cannot apply - the edit tool replaces content and never creates a file)\n--- intended content ---\n${newText}`) };
      return { kind: "edit", title: `Edit ${rel}`, detail: old.truncated ? big(old, newText) : changedLines(old.text, newText) };
    }
    case "write": {
      const content = String(args.content ?? "");
      if (!readText) return { kind: "write", title: `Write ${rel}`, detail: clip(content) };
      const old = readText(rel);
      const title = old === null ? `Create ${rel} (${content.split(/\r?\n/).length} lines)` : `Overwrite ${rel}`;
      if (old === null) return { kind: "write", title, detail: clip(content) };
      return { kind: "write", title, detail: old.truncated ? big(old, content) : changedLines(old.text, content) };
    }
    case "bash": {
      const cmd = String(args.cmd ?? "");
      return { kind: "bash", title: `Run: ${cmd.split(/\r?\n/)[0]?.slice(0, 120) ?? ""}`, detail: clip(cmd, 2000) };
    }
    case "verify":
      return { kind: "generic", title: "Run project verification", detail: "Tests, typecheck and build through the project's detected package manager. This executes repository code." };
    case "camera_look": {
      const q = String(args.question ?? "").trim();
      return { kind: "camera", title: "Look through the camera", detail: q ? `Question: ${clip(q, 500)}` : "Describe the current frame." };
    }
    case "run_js": {
      // The most dangerous tool gets the most visible summary (audit
      // EH-SEC-3): model-written code or the whole op batch, at the full cap.
      const code = String(args.code ?? "");
      if (code) {
        const tier = String(args.tier ?? "execute");
        const lane = tier === "execute" ? "the OS sandbox lane" : tier === "redteam" ? "the red-team lane" : "static review only";
        return { kind: "generic", title: `Run model-written code in ${lane} (${code.length.toLocaleString("en-US")} chars)`, detail: clip(code) };
      }
      return { kind: "generic", title: `Batch of ${Array.isArray(args.ops) ? args.ops.length : "?"} read-only operations`, detail: clip(JSON.stringify(args.ops ?? {}, null, 1)) };
    }
    default: {
      const compact = Object.entries(args ?? {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");
      return { kind: "generic", title: tool, detail: compact ? clip(compact, 600) : "(no arguments)" };
    }
  }
}

// ---- state (in memory, for the life of the runtime) -------------------------------------

const requests = new Map<string, ApprovalRequest>();
const waiters = new Map<string, (d: Decision) => void>();
const resolvedOrder: string[] = [];
const grants = new Map<string, Grant>();
const deniedInRun = new Map<string, Set<string>>();
const DENIED_RUN_CAP = 500;

function settle(req: ApprovalRequest, status: Exclude<ApprovalStatus, "pending">, grantId: string | null = null): Decision {
  req.status = status;
  req.decidedAt = Date.now();
  req.grantId = grantId;
  resolvedOrder.push(req.id);
  if (status === "denied" && req.runId) {
    if (!deniedInRun.has(req.runId)) {
      deniedInRun.set(req.runId, new Set());
      if (deniedInRun.size > DENIED_RUN_CAP) deniedInRun.delete(deniedInRun.keys().next().value as string);
    }
    deniedInRun.get(req.runId)!.add(callKey(req.tool, req.argsDigest));
  }
  broadcast(req.worktree, "approval-resolved", { id: req.id, sessionId: req.sessionId, status, grantId });
  return { approved: status === "approved", reason: status, grantId };
}

const callKey = (tool: string, digest: string): string => `${tool}\0${digest}`;

function trim(): void {
  while (resolvedOrder.length > policy.keepResolved) {
    const id = resolvedOrder.shift();
    if (id) requests.delete(id);
  }
  const now = Date.now();
  for (const [id, g] of grants) if (g.expiresAt !== null && g.expiresAt <= now) grants.delete(id);
}

/** Create a request and wait for the operator. Resolves on decision, timeout or cancellation. */
export function requestApproval(
  input: { sessionId: string; runId?: string | null; worktree: string; tool: string; args: Record<string, unknown>; summary: ApprovalSummary },
  opts?: { isCancelled?: () => boolean },
): Promise<Decision> {
  const now = Date.now();
  const req: ApprovalRequest = {
    id: `apr_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    worktree: input.worktree,
    tool: input.tool,
    argsDigest: callDigest(input.tool, input.args),
    summary: { kind: input.summary.kind, title: input.summary.title.slice(0, 300), detail: clip(input.summary.detail) },
    createdAt: now,
    expiresAt: now + policy.requestTimeoutMs,
    status: "pending",
    decidedAt: null,
    grantId: null,
  };
  requests.set(req.id, req);
  audit({ tool: "approval", session: req.sessionId, note: `request ${req.tool} ${req.id}` });
  broadcast(req.worktree, "approval", { request: req });
  return new Promise<Decision>((resolve) => {
    let done = false;
    const finish = (d: Decision): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      waiters.delete(req.id);
      trim();
      resolve(d);
    };
    waiters.set(req.id, finish);
    const timer = setInterval(() => {
      if (done) return;
      if (opts?.isCancelled?.()) { finish(settle(req, "cancelled")); return; }
      if (Date.now() >= req.expiresAt) finish(settle(req, "expired"));
    }, 250);
    timer.unref?.();
  });
}

function createGrant(req: ApprovalRequest, spec: GrantSpec): { ok: true; grant: Grant } | { ok: false; error: string } {
  if (alwaysAsks(req.tool)) return { ok: false, error: `${req.tool} asks on every use - it cannot be covered by a grant` };
  if (spec.scope !== "args" && spec.scope !== "tool") return { ok: false, error: "grant scope must be \"args\" or \"tool\"" };
  const uses = spec.uses ?? null;
  if (uses !== null && (!Number.isInteger(uses) || uses < 1 || uses > policy.grantMaxUses)) return { ok: false, error: `grant uses must be null (unbounded) or 1 .. ${policy.grantMaxUses}` };
  const ttl = spec.ttlMs ?? null;
  if (ttl !== null && (!Number.isInteger(ttl) || ttl < 1000 || ttl > policy.grantMaxTtlMs)) return { ok: false, error: `grant ttlMs must be null or 1 s .. ${policy.grantMaxTtlMs} ms` };
  const grant: Grant = {
    id: `grt_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    sessionId: req.sessionId,
    tool: req.tool,
    argsDigest: spec.scope === "args" ? req.argsDigest : null,
    maxUses: uses,
    used: 0,
    expiresAt: ttl === null ? null : Date.now() + ttl,
    createdAt: Date.now(),
    label: String(spec.label ?? (spec.scope === "args" ? "this call" : req.tool)).slice(0, 80),
    viaApprovalId: req.id,
  };
  grants.set(grant.id, grant);
  audit({ tool: "approval", session: req.sessionId, note: `grant ${grant.id} ${req.tool} scope=${spec.scope} uses=${uses ?? "unbounded"} ttl=${ttl ?? "none"}` });
  return { ok: true, grant };
}

/**
 * The operator's decision. A grant may be created only by an approval - a
 * denial never mints authority.
 */
export function decideApproval(id: string, decision: { approved: boolean; grant?: GrantSpec }):
  | { ok: true; request: ApprovalRequest }
  | { ok: false; error: string } {
  const req = requests.get(id);
  if (!req) return { ok: false, error: "unknown approval request" };
  if (req.status !== "pending") return { ok: false, error: `request is already ${req.status}` };
  // A denial that carries a grant is a malformed decision, not a denial:
  // it is refused and the request stays pending for a proper answer.
  if (!decision.approved && decision.grant) return { ok: false, error: "a grant can only be created by an approval" };
  let grantId: string | null = null;
  if (decision.approved && decision.grant) {
    const g = createGrant(req, decision.grant);
    if (!g.ok) return g;
    grantId = g.grant.id;
  }
  const d = settle(req, decision.approved ? "approved" : "denied", grantId);
  audit({ tool: "approval", session: req.sessionId, note: `decide ${req.tool} ${req.id} ${d.reason}${grantId ? ` +grant` : ""}` });
  waiters.get(id)?.(d);
  return { ok: true, request: req };
}

/** A matching grant answers the call; one use is consumed. */
export function consumeGrant(sessionId: string, tool: string, digest: string): Grant | null {
  if (alwaysAsks(tool)) return null; // whatever a grant says, this tool asks
  trim();
  let best: Grant | null = null;
  for (const g of grants.values()) {
    if (g.sessionId !== sessionId || g.tool !== tool) continue;
    if (g.argsDigest !== null && g.argsDigest !== digest) continue;
    if (g.maxUses !== null && g.used >= g.maxUses) continue;
    // The narrower grant (bound to this exact call) wins over the tool-wide one.
    if (!best || (g.argsDigest !== null && best.argsDigest === null) || g.createdAt > best.createdAt) best = g;
  }
  if (!best) return null;
  best.used++;
  audit({ tool: "approval", session: sessionId, note: `grant used ${best.id} ${tool} ${best.used}/${best.maxUses ?? "unbounded"}` });
  if (best.maxUses !== null && best.used >= best.maxUses) grants.delete(best.id);
  return best;
}

/** True when this exact call was declined earlier in the same run (no second prompt). */
export function isDeniedInRun(runId: string | null | undefined, tool: string, digest: string): boolean {
  return !!runId && !!deniedInRun.get(runId)?.has(callKey(tool, digest));
}

/** End every pending request of a session or run (cancellation, session close). */
export function cancelPending(where: { sessionId?: string; runId?: string }): number {
  let n = 0;
  for (const [id, req] of requests) {
    if (req.status !== "pending") continue;
    if (where.sessionId !== undefined && req.sessionId !== where.sessionId) continue;
    if (where.runId !== undefined && req.runId !== where.runId) continue;
    waiters.get(id)?.(settle(req, "cancelled"));
    audit({ tool: "approval", session: req.sessionId, note: `cancel ${req.tool} ${req.id}` });
    n++;
  }
  return n;
}

/** Pending first (oldest first), then the most recent resolved ones. Never carries arguments - only the summary. */
export function listApprovals(): ApprovalRequest[] {
  trim();
  const all = [...requests.values()];
  const pending = all.filter((r) => r.status === "pending").sort((x, y) => x.createdAt - y.createdAt);
  const resolved = all.filter((r) => r.status !== "pending").sort((x, y) => (y.decidedAt ?? 0) - (x.decidedAt ?? 0)).slice(0, policy.keepResolved);
  return [...pending, ...resolved];
}

export function listGrants(): Grant[] {
  trim();
  return [...grants.values()];
}

export function revokeGrant(id: string): boolean {
  if (!grants.delete(id)) return false;
  audit({ tool: "approval", note: `grant revoked ${id}` });
  return true;
}
