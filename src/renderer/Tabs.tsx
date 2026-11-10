// Event Horizon Code — Editor tabs (VS Code structure)

export default function Tabs(props: {
  files: () => string[];
  active: () => string;
  onSelect: (f: string) => void;
  onClose: (f: string) => void;
}) {
  return (
    <div class="tabs">
      {props.files().map((f) => (
        <div class={f === props.active() ? "tab tab-on" : "tab"} onClick={() => props.onSelect(f)}>
          <span class="tab-name">{f.split(/[\\/]/).pop()}</span>
          <span class="tab-close" title="Close" onClick={(e) => { e.stopPropagation(); props.onClose(f); }}>×</span>
        </div>
      ))}
    </div>
  );
}
