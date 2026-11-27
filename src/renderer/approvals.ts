// Event Horizon Code — pending approvals (the agent is waiting on you).
//
// One list for every session and window: the chat column shows the cards of
// its own session, the status bar counts all of them. The server owns the
// requests and every decision; this only mirrors them. Decisions go out
// through the main-process proxy like every other call - the renderer never
// holds a credential and cannot mint a grant by itself.

import { createSignal } from "solid-js";
import { apiFetch, apiJson } from "./api";

export type ApprovalRequest = {
  id: string;
  sessionId: string;
  runId: string | null;
  tool: string;
  summary: { kind: string; title: string; detail: string };
  createdAt: number;
  expiresAt: number;
  status: string;
};

export type GrantSpec = { scope: "args" | "tool"; uses?: number | null; ttlMs?: number | null; label?: string };
export type Grant = { id: string; sessionId: string; tool: string; argsDigest: string | null; maxUses: number | null; used: number; expiresAt: number | null; label: string };

const [pending, setPending] = createSignal<ApprovalRequest[]>([]);
const [grants, setGrants] = createSignal<Grant[]>([]);
const [error, setError] = createSignal("");
// Tools that ask on every use, from the server's policy. It starts at the
// server's floor so the card is right before the first fetch lands.
const [noGrantTools, setNoGrantTools] = createSignal<string[]>(["camera_look"]);

export const pendingApprovals = pending;
export const activeGrants = grants;
export const approvalsError = error;

/** True for a tool that must ask on every use and so offers no "for this session". */
export const alwaysAsks = (tool: string): boolean => noGrantTools().includes(tool);

/** The requests waiting in one session - what its chat column shows. */
export const pendingFor = (sessionId: string): ApprovalRequest[] => pending().filter((r) => r.sessionId === sessionId);

export function noteApproval(req: ApprovalRequest): void {
  if (!req?.id) return;
  setPending((l) => (l.some((r) => r.id === req.id) ? l : req.status === "pending" ? [...l, req] : l));
}

export function resolveApproval(id: string): void {
  setPending((l) => l.filter((r) => r.id !== id));
}

/** Catch-up for events a disconnected stream may have missed. */
export async function refreshApprovals(): Promise<void> {
  try {
    const [queue, g] = await Promise.all([
      apiJson<{ tools?: ApprovalRequest[] }>("/api/approvals"),
      apiJson<{ grants?: Grant[]; policy?: { noGrantTools?: string[] } }>("/api/approvals/grants"),
    ]);
    setPending((queue.tools ?? []).filter((r) => r.status === "pending"));
    setGrants(g.grants ?? []);
    if (Array.isArray(g.policy?.noGrantTools)) setNoGrantTools(g.policy!.noGrantTools!);
    setError("");
  } catch (e) {
    setError(String((e as Error)?.message ?? e));
  }
}

export async function decideApproval(id: string, approved: boolean, grant?: GrantSpec): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await apiFetch(`/api/approvals/${encodeURIComponent(id)}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved, ...(grant ? { grant } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || body.ok !== true) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    resolveApproval(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

export async function revokeGrant(id: string): Promise<void> {
  try {
    await apiFetch(`/api/approvals/grants/${encodeURIComponent(id)}`, { method: "DELETE" });
  } finally {
    void refreshApprovals();
  }
}
