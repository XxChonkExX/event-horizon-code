// Event Horizon Code — Approval card: the agent is waiting on you.
// Shows exactly what will happen (the diff, the command, the question) and
// offers the operator's decisions: once, for this session, or not at all.
// Compact on purpose: in a short chat column every part of it - what it is,
// what it changes, and the buttons - must be visible without scrolling.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { alwaysAsks, decideApproval, type ApprovalRequest } from "./approvals";

// Which "for this session" a tool offers. Edits and writes repeat across a
// coding session, so their grant is tool-wide. A command or a verification is
// granted for that exact call only - never "any command". A tool that asks on
// every use (a camera look, by policy) offers no grant at all.
function sessionScope(tool: string): { scope: "args" | "tool"; label: string; title: string } | null {
  if (alwaysAsks(tool)) return null;
  return tool === "edit" || tool === "write"
    ? { scope: "tool", label: "Approve for session", title: `Answer every ${tool} in this session without asking again, until the runtime stops. Review or revoke it from the status bar.` }
    : { scope: "args", label: "Approve for session", title: "Answer this exact call again in this session without asking. It never covers a different command." };
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function ApprovalCard(props: { request: ApprovalRequest }) {
  const r = () => props.request;
  const [busy, setBusy] = createSignal(false);
  const [note, setNote] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });
  const decide = async (approved: boolean, grant?: { scope: "args" | "tool" }): Promise<void> => {
    setBusy(true);
    const out = await decideApproval(r().id, approved, grant);
    setBusy(false);
    if (!out.ok) setNote(out.error ?? "the decision did not go through");
  };
  const sc = () => sessionScope(r().tool);
  return (
    <div class="msg msg-approval" role="region" aria-label="Approval needed" aria-live="polite">
      <div class="approval-head">
        <span class="approval-mark" aria-hidden="true">!</span>
        <span class="approval-title">{r().summary.title}</span>
      </div>
      <Show when={r().summary.detail}><pre class="approval-detail">{r().summary.detail}</pre></Show>
      <Show when={note()}><div class="approval-note">{note()}</div></Show>
      <div class="approval-actions">
        {/* No autofocus on purpose: a prompt must not pull the caret out of the composer while the user types. It is announced (aria-live) and one Tab away. */}
        <button class="approval-btn approval-yes" disabled={busy()} onClick={() => void decide(true)}>Approve once</button>
        <Show when={sc()}>
          <button class="approval-btn" disabled={busy()} title={sc()!.title} onClick={() => void decide(true, { scope: sc()!.scope })}>
            {sc()!.label}
          </button>
        </Show>
        <button class="approval-btn approval-no" disabled={busy()} title="Do not run it. The agent is told that you declined." onClick={() => void decide(false)}>Deny</button>
      </div>
      <div class="approval-meta">{sc() ? "" : "asks every use · "}waits up to {mmss(r().expiresAt - now())}{r().sessionId !== "" ? ` · session ${r().sessionId}` : ""}</div>
    </div>
  );
}
