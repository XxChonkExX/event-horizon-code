// Event Horizon Code — Panel splitter (pointer-capture drag handle)
// direction "col": resize columns (delta = x movement)
// direction "row": resize rows (delta = y movement)

import { createSignal, onCleanup } from "solid-js";

export default function Splitter(props: {
  direction: "col" | "row";
  class?: string;
  onDelta: (delta: number) => void;
  onEnd?: () => void;
}) {
  const [dragging, setDragging] = createSignal(false);
  let last = 0;

  const pos = (e: PointerEvent) => (props.direction === "col" ? e.clientX : e.clientY);

  const down = (e: PointerEvent) => {
    setDragging(true);
    last = pos(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = props.direction === "col" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };
  const move = (e: PointerEvent) => {
    if (!dragging()) return;
    const cur = pos(e);
    const d = cur - last;
    last = cur;
    if (d !== 0) props.onDelta(d);
  };
  const up = (e: PointerEvent) => {
    if (!dragging()) return;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    props.onEnd?.();
  };

  onCleanup(() => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  return (
    <div
      class={`ehc-splitter ${props.direction === "col" ? "ehc-splitter-v" : "ehc-splitter-h"} ${dragging() ? "ehc-splitter-drag" : ""} ${props.class ?? ""}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    />
  );
}
