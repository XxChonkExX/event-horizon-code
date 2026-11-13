// Event Horizon Code — Editor tabs (VS Code structure)
// Classes ehc-prefixed: generic names collided with the editor's internal styles.

export default function Tabs(props: {
  files: () => string[];
  active: () => string;
  onSelect: (f: string) => void;
  onClose: (f: string) => void;
}) {
  return (
    <div class="ehc-tabs">
      {props.files().map((f) => (
        <div class={f === props.active() ? "ehc-tab ehc-tab-on" : "ehc-tab"} onClick={() => props.onSelect(f)}>
          <span class="ehc-tab-name">{f.split(/[\\/]/).pop()}</span>
          <span class="ehc-tab-close" title="Close" onClick={(e) => { e.stopPropagation(); props.onClose(f); }}>×</span>
        </div>
      ))}
    </div>
  );
}
