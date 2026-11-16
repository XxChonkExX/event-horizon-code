// Event Horizon Code — Activity bar (VS Code structure, dependency-free glyphs)

export type Panel = "sidebar" | "chat" | "terminal" | "panels";

export default function ActivityBar(props: {
  open: () => Record<Panel, boolean>;
  toggle: (p: Panel) => void;
  sessionsActive: () => boolean;
  onSessions: () => void;
}) {
  const item = (id: Panel, glyph: string, title: string) => (
    <button
      class={props.open()[id] ? "act act-on" : "act"}
      title={title}
      onClick={() => props.toggle(id)}
    >
      {glyph}
    </button>
  );
  return (
    <div class="activity-bar">
      {item("sidebar", "\u25A3", "Worktrees / explorer")}
      {item("chat", "\u2726", "Agent chat")}
      {item("terminal", "\u25B6", "Terminal")}
      {item("panels", "\u2699", "Panels (toolchain / sandbox / agentwatch)")}
      <button
        class={props.sessionsActive() ? "act act-on" : "act"}
        title="Session log manager — open, rename, fork, delete sessions"
        aria-label="Session log manager"
        onClick={props.onSessions}
      >
        {"\u2630"}
      </button>
      <div class="act-spacer" />
    </div>
  );
}
