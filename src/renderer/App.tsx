// Event Horizon Code — Renderer workbench (SolidJS + Monaco)
// Multi-window aware: URL query ?session=<id> selects session/worktree.
// Layout: left file tree + sessions, center Monaco, right chat + approvals,
// bottom terminal. Streaming diffs token-by-token. No filesystem via IPC.

import { createSignal } from "solid-js";

const session = new URLSearchParams(location.search).get("session") ?? "default";

export default function App() {
  const [messages, setMessages] = createSignal<string[]>([]);
  return (
    <div class="workbench">
      <header>Event Horizon Code — session {session}</header>
      <section class="editor">Monaco mounts here (vscode Monaco, MIT)</section>
      <aside class="chat">
        <ul>{messages().map((m) => <li>{m}</li>)}</ul>
        <input placeholder="/think:high  describe the fix…" />
      </aside>
    </div>
  );
}
