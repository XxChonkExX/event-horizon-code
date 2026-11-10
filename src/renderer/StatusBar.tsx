// Event Horizon Code — Status bar (VS Code structure): session/worktree left, model/think/shader right

export default function StatusBar(props: {
  session: string;
  model: () => string;
  think: () => string;
  shader: () => string;
  onShader: () => void;
}) {
  return (
    <div class="status-bar">
      <span>session {props.session}</span>
      <span class="status-dim">·</span>
      <span>worktree .eventhorizon/worktrees</span>
      <div class="status-spacer" />
      <span class="status-badge">{props.model() || "no model"}</span>
      <span class="status-badge">think: {props.think()}</span>
      <button class="status-badge status-btn" title="Cycle shader background" onClick={props.onShader}>
        shader: {props.shader()}
      </button>
    </div>
  );
}
