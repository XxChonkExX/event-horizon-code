// Event Horizon Code — Sandbox controls (SolidJS)
// Mode selector: host | docker | sbx | detonate. Network policy: off | balanced | strict.
// Shows generated command for review. Nothing executes automatically.
// Detonate = unclean lane. No network, no credentials, time-boxed.

import { createSignal } from "solid-js";

type Mode = "host" | "docker" | "sbx" | "detonate";
type Net = "off" | "balanced" | "strict";

export default function SandboxControls() {
  const [mode, setMode] = createSignal<Mode>("host");
  const [net, setNet] = createSignal<Net>("balanced");
  const [cmd, setCmd] = createSignal("");

  const preview = () => {
    if (mode() === "host") return setCmd("Host mode. No sandbox. Lightest path while CodeRed-418 trains.");
    if (mode() === "docker") return setCmd(`docker run -v <worktree>:/workspace -w /workspace eventhorizon/agent:latest bash  # network=${net()}`);
    if (mode() === "detonate") return setCmd(`sbx run --clone detonate-<worktree> <worktree> --network off  # UNCLEAN lane. No net, no creds, 30s cap. Review tier first.`);
    return setCmd(`sbx run --clone <name> <worktree> --network ${net()}  # private clone, push branches, PR for review`);
  };

  return (
    <div class="sandbox-controls">
      <h3>Sandbox</h3>
      <label>
        Mode
        <select value={mode()} onChange={(e) => { setMode(e.target.value as Mode); preview(); }}>
          <option value="host">host (default, clean)</option>
          <option value="docker">docker (clean)</option>
          <option value="sbx">sbx microVM (clean)</option>
          <option value="detonate">detonate (unclean)</option>
        </select>
      </label>
      <label>
        Network
        <select value={net()} onChange={(e) => { setNet(e.target.value as Net); preview(); }}>
          <option value="off">off</option>
          <option value="balanced">balanced</option>
          <option value="strict">strict</option>
        </select>
      </label>
      <button onClick={preview}>Preview command</button>
      <pre>{cmd()}</pre>
      <p>Host socket never shared. No Docker Desktop bundled. Sandbox is opt-in.</p>
    </div>
  );
}
