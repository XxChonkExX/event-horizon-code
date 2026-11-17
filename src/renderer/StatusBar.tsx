// Event Horizon Code — Status bar (VS Code structure): session/worktree/file left, model/think/shader right

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
