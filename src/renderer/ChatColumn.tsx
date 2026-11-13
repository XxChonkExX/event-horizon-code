// Event Horizon Code — Chat column (shared by main workbench and chat pop-out)

import { For } from "solid-js";

export default function ChatColumn(props: {
  messages: () => string[];
  input: () => string;
  setInput: (v: string) => void;
  onSend: () => void;
  models: () => string[];
  model: () => string;
  setModel: (v: string) => void;
  think: () => string;
  setThink: (v: string) => void;
  compact?: boolean; // pop-out variant: hide detonation footer
}) {
  return (
    <aside class="chat">
      <ul>{props.messages().map((m) => <li>{m}</li>)}</ul>
      <div class="composer">
        <input
          value={props.input()}
          onInput={(e) => props.setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") props.onSend(); }}
          placeholder="/think:high  describe the fix…"
        />
        <button onClick={() => props.onSend()}>Send</button>
      </div>
      <div class="model-row">
        <span>model</span>
        <select value={props.model()} onChange={(e) => props.setModel(e.target.value)}>
          <option value="">(none — echo)</option>
          <For each={props.models()}>{(m) => <option value={m}>{m}</option>}</For>
        </select>
        <span>think</span>
        <select value={props.think()} onChange={(e) => props.setThink(e.target.value)}>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="max">max</option>
        </select>
      </div>
      {props.compact ? null : <p>Detonation lane available. Unclean inputs route to detonate (microVM, no net).</p>}
    </aside>
  );
}
