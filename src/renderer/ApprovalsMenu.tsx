// Event Horizon Code — Approvals menu: everything waiting on you, and every
// grant you have given, from one place. Opened from the status bar, so a
// prompt raised in another session or window is never out of sight.

import { For, Show } from "solid-js";
import { activeGrants, pendingApprovals, revokeGrant } from "./approvals";
import ApprovalCard from "./ApprovalCard";

export default function ApprovalsMenu(props: { onClose: () => void }) {
  return (
    <div class="approvals-menu" role="dialog" aria-label="Approvals and grants">
      <div class="approvals-menu-head">
        <span>Approvals &amp; grants</span>
        <button class="approval-btn" onClick={props.onClose}>Close</button>
      </div>

      <div class="approvals-menu-sub">Waiting on you</div>
      <Show when={pendingApprovals().length === 0}>
        <div class="approval-meta">Nothing is waiting on you.</div>
      </Show>
      <For each={pendingApprovals()}>{(r) => <ApprovalCard request={r} />}</For>

      <div class="approvals-menu-sub">Grants - answer without asking, until the runtime stops</div>
      <Show when={activeGrants().length === 0}>
        <div class="approval-meta">No grants. (Auto-approve is a composer setting and is not listed here.)</div>
      </Show>
      <For each={activeGrants()}>
        {(g) => (
          <div class="grant-row">
            <span class="grant-label">
              <strong>{g.tool}</strong> · {g.argsDigest ? "this exact call" : "any call of it"} · session {g.sessionId}
              {g.maxUses !== null ? ` · used ${g.used} of ${g.maxUses}` : ` · used ${g.used}`}
            </span>
            <button class="approval-btn approval-no" onClick={() => void revokeGrant(g.id)}>Revoke</button>
          </div>
        )}
      </For>
    </div>
  );
}
