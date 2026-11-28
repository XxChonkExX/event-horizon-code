// Event Horizon Code — Status bar (VS Code structure): session/worktree/file left, model/think/shader right

import { Show, onMount } from "solid-js";
import { halted, ensureSensorPolling, liveCount, resumeSensors, stopEverything, watchCount } from "./sensorStore";

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
  /** Reveals the Sensors panel. */
  onSensors: () => void;
}) {
  // This bar is on screen in every layout, so it is where the bus is watched
  // from: one poll per window, however many panels are open.
  onMount(() => ensureSensorPolling());
  const live = (): string => {
    const l = liveCount(), w = watchCount();
    return `${l} live${w ? ` \u00B7 ${w} watching` : ""}`;
  };
  return (
    <div class="status-bar">
      <span>session {props.session}</span>
      <span class="status-dim">·</span>
      <span title="the directory this session's tools operate in">worktree {props.worktree()}</span>
      <span class="status-dim">·</span>
      <span class="status-file" title={props.file()}>{props.file()}</span>
      <div class="status-spacer" />
      {/* Sensors: shown whenever anything could observe. The stop is one
          activation from any layout, needs no panel, and asks nothing. */}
      <Show when={halted() || liveCount() > 0 || watchCount() > 0}>
        {/* The wrapper is the live region, not the buttons: a role on a button
            would replace its button role for assistive technology. */}
        <span class="status-sensors-group" role="status">
          <button
            class="status-badge status-btn status-sensors"
            classList={{ "status-sensors-halted": halted() }}
            title={halted()
              ? "Sensors are stopped: nothing observes until you resume. Click to open the Sensors panel."
              : `${live()}. Click to open the Sensors panel.`}
            onClick={props.onSensors}
          >
            {halted() ? "sensors: stopped" : `sensors: ${live()}`}
          </button>
          <button
            class="status-badge status-btn status-stop"
            classList={{ "status-resume": halted() }}
            title={halted()
              ? "Lift the stop. Nothing starts by itself - every source is still off."
              : "The one switch: every sensor off, every watch removed, the bridge closed, and nothing observes until you resume."}
            onClick={() => void (halted() ? resumeSensors() : stopEverything())}
          >
            {halted() ? "resume sensors" : "stop all sensors"}
          </button>
        </span>
      </Show>
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
