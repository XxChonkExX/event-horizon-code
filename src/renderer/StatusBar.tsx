// Event Horizon Code — Status bar (VS Code structure): session/worktree/file left, model/think/shader right

import { Show } from "solid-js";

export default function StatusBar(props: {
  session: string;
  file: () => string;
  worktree: () => string;
  model: () => string;
  think: () => string;
  shader: () => string;
  onShader: () => void;
  paused: () => boolean;
  onPause: () => void;
  approvals: () => number;
  grants: () => number;
  onApprovals: () => void;
}) {
  return (
    <div class="status-bar">
      <span>session {props.session}</span>
      <span class="status-dim">·</span>
      <span title="the directory this session's tools operate in">worktree {props.worktree()}</span>
      <span class="status-dim">·</span>
      <span class="status-file" title={props.file()}>{props.file()}</span>
      <div class="status-spacer" />
      <span class="status-badge">{props.model() || "no model"}</span>
      <span class="status-badge">think: {props.think()}</span>
      <button class="status-badge status-btn" title="Cycle shader background" onClick={props.onShader}>
        shader: {props.shader()}
      </button>
      {/* Counts every session and window: a prompt raised elsewhere must not go unnoticed. */}
      <Show when={props.approvals() > 0 || props.grants() > 0}>
        <button
          class="status-badge status-btn status-approvals"
          classList={{ "status-approvals-waiting": props.approvals() > 0 }}
          role="status"
          title={props.approvals() > 0
            ? `${props.approvals()} tool call(s) are waiting for your approval. Click to decide.`
            : `${props.grants()} grant(s) answer without asking. Click to review or revoke.`}
          onClick={props.onApprovals}
        >
          {props.approvals() > 0 ? `approvals waiting: ${props.approvals()}` : `grants: ${props.grants()}`}
        </button>
      </Show>
      <button
        class="status-badge status-btn"
        classList={{ "agents-paused": props.paused() }}
        title={props.paused() ? "Agents paused - resume autonomous work" : "Pause all agents between steps"}
        onClick={props.onPause}
      >
        agents: {props.paused() ? "paused" : "running"}
      </button>
    </div>
  );
}
