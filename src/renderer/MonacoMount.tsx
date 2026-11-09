// Event Horizon Code — Monaco mount
// Resolves language id from file extension via languages/*/language.json fileExtensions.
// Light first paint, editor init on demand.

import { onMount } from "solid-js";

export default function MonacoMount({ file }: { file: string }) {
  let ref: HTMLDivElement | undefined;

  onMount(() => {
    // Monaco loader is optional in scaffold. If monaco-editor is installed, init here.
    // Fallback placeholder keeps the window viable without bundle bloat.
    if (ref) ref.textContent = `Monaco: ${file}`;
  });

  return <div class="monaco-mount" ref={ref} data-file={file}>Monaco mounts here. File: {file}</div>;
}
